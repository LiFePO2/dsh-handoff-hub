/**
 * Handoff Hub — workspace-local handoff synchronization for sibling model
 * sessions.
 *
 * Design constraints (stability first):
 * - only Node built-ins are imported, so activation cannot fail on module
 *   resolution or a Harness version drift;
 * - no timers, no filesystem watchers, no session-event writes, no prompt
 *   sections; all work happens inside one tool call;
 * - all registrations live in one `ctx.effect` and are disposed on unload;
 * - every target of a fan-out is isolated, so one stale session cannot fail the
 *   whole reminder;
 * - reminder delivery is delegated to the shipped `ctx.schedule` service, which
 *   persists the task and enqueues a user message into the target session.
 */
import { normalizeConfig } from './lib/config.js'
import {
  auditTarget,
  callerCwd,
  callerSessionId,
  defaultDocName,
  docPath,
  isDelegated,
  listLiveSessions,
  readDocMeta,
  readParticipants,
  removeParticipant,
  resolveReference,
  resolveRoom,
  validateDocName,
  validateName,
  validateTargetSessionId,
  writeDocContent,
  writeParticipant
} from './lib/room.js'
import { boardReport, nudgePrompt, nudgeReport, noPeersReport } from './lib/prompts.js'
import { HubError, comparablePath, comparableText, describeError, formatBytes, formatTime, oneLine, shortId } from './lib/util.js'

export const name = 'handoff-hub'

/** Without the tool registry or the durable schedule service this plugin is inert. */
export const inject = ['tools', 'schedule']

/** Prefix that marks schedule tasks owned by this plugin (used for cleanup). */
const TITLE_MARKER = '[handoff-hub]'

/** Shared model-facing output contract. */
const OUTPUT = Object.freeze({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      report: { type: 'string' }
    },
    required: ['report']
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }]
})

const BOARD_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
})

const JOIN_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description: 'Display name this session uses in the handoff room, at most 48 characters and unique in the room (for example: codex).'
    },
    doc: {
      type: 'string',
      description: 'Handoff document file name inside the room, ending in .md, with no path separators. Defaults to a slug of `name`.'
    },
    content: {
      type: 'string',
      description: 'Complete handoff document text to write atomically. Omit it to register a document you already wrote with your file tools.'
    },
    overwrite: {
      type: 'boolean',
      description: 'Replace an existing, not-yet-registered document when writing content. Defaults to false.'
    }
  },
  required: ['name']
})

const LEAVE_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
})

const NUDGE_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      description: 'Optional extra sentence appended to each reminder, at most 500 characters.'
    },
    references: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 5 workspace-relative or absolute .md/.markdown/.txt paths that every target should read first (for example a usage guide). Paths are validated inside the caller workspace and bounded by maxDocBytes; only paths are delivered, not content.'
    },
    targets: {
      type: 'array',
      items: { type: 'string' },
      description: 'Explicit session ids to remind. Each target is verified against durable Session storage and must be an ordinary, unarchived Session in this workspace. Omit to remind every registered peer in this room except this session.'
    },
    includeSelf: {
      type: 'boolean',
      description: 'Also deliver the reminder to this session. Defaults to false.'
    },
    delaySeconds: {
      type: 'integer',
      description: 'Delivery delay in seconds, 1 through 60. Defaults to the plugin configuration.'
    }
  },
  required: []
})

const BOARD_DESCRIPTION =
  'Read the shared handoff room for this workspace: this session\'s registration, every registered peer\'s handoff document path with size and last-modified time, and ids of live unregistered sessions in the same workspace. It only indexes documents — read them with your file tools. Use it before handoff_join or handoff_nudge to see who is collaborating.'

const JOIN_DESCRIPTION =
  'Register this session in the shared handoff room or update its registration. `name` is the display name peers see; `doc` names the handoff file inside the room (defaults to `<name>.md`); pass `content` to write that file atomically, or omit content to register a file you already wrote. Duplicate names, documents owned by another session, and path-like file names are rejected. Returns the refreshed peer list.'

const NUDGE_DESCRIPTION =
  'Remind other registered model sessions in this workspace to read each other\'s handoff documents now. Each peer receives one durable scheduled user message listing the peer documents (absolute paths, sizes, times) — plus up to 5 extra reference paths — and asking it to read them, update its own document, and re-register. Use it after publishing a handoff peers must see, or when the user asks all models to synchronize. Explicit targets are verified against durable Session storage to be ordinary, unarchived sessions in this workspace. Returns one queue receipt per peer; Schedule delivers asynchronously, so a queued reminder can still fail later (for example after a target is archived).'

const LEAVE_DESCRIPTION =
  'Remove this session from the shared handoff room. Only the roster entry is removed; the handoff document file is left untouched. Use it when this session is done collaborating or should stop receiving nudges.'

/**
 * Plugin entry.
 * @param {any} ctx row Host context
 * @param {unknown} rawConfig row config from the bundle patch
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const definitions = [
    makeDefinition(ctx, config, 'handoff_board', BOARD_DESCRIPTION, BOARD_PARAMETERS, runBoard),
    makeDefinition(ctx, config, 'handoff_join', JOIN_DESCRIPTION, JOIN_PARAMETERS, runJoin),
    makeDefinition(ctx, config, 'handoff_nudge', NUDGE_DESCRIPTION, NUDGE_PARAMETERS, runNudge),
    makeDefinition(ctx, config, 'handoff_leave', LEAVE_DESCRIPTION, LEAVE_PARAMETERS, runLeave)
  ]

  ctx.effect(() => {
    const cleanups = []
    try {
      for (const definition of definitions) cleanups.push(ctx.tools.register(definition))
    } catch (error) {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup?.()
        } catch {
          /* best effort */
        }
      }
      warn(ctx, `tool registration failed: ${describeError(error)}`)
    }
    return () => {
      for (const cleanup of cleanups) {
        try {
          cleanup?.()
        } catch {
          /* best effort */
        }
      }
    }
  }, 'handoff-hub: register handoff_board, handoff_join, handoff_nudge and handoff_leave')
}

function makeDefinition(ctx, config, toolName, description, parameters, run) {
  return {
    name: toolName,
    description,
    parameters,
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return { report: await run(ctx, config, args ?? {}, exec ?? {}) }
      } catch (error) {
        return { report: `[handoff-hub] ${toolName} failed: ${describeError(error)}` }
      }
    }
  }
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`handoff-hub: ${message}`)
  } catch {
    /* logging must never fail a tool call */
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* handoff_board                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

async function runBoard(ctx, config, _args, exec) {
  const agent = exec.agent
  const room = resolveRoom(ctx, config, agent)
  const sessionId = callerSessionId(agent)
  const { participants, warnings } = await readParticipants(room)
  const selfEntry = participants.find((participant) => participant.sessionId === sessionId)

  const peers = []
  for (const participant of participants) {
    if (participant.sessionId === sessionId) continue
    peers.push({
      name: participant.name,
      sessionId: participant.sessionId,
      doc: participant.doc,
      absolute: docPath(room, participant.doc),
      meta: await readDocMeta(room, participant.doc)
    })
  }
  peers.sort(compareDocs)

  const self = selfEntry
    ? {
        sessionId,
        registered: true,
        name: selfEntry.name,
        doc: selfEntry.doc,
        absolute: docPath(room, selfEntry.doc),
        meta: await readDocMeta(room, selfEntry.doc)
      }
    : { sessionId, registered: false }

  return boardReport({
    language: config.promptLanguage,
    room,
    self,
    peers,
    unregistered: await listLiveSessions(ctx, agent, room, participants),
    warnings
  })
}

function compareDocs(left, right) {
  const leftTime = left.meta?.exists ? left.meta.mtimeMs : -1
  const rightTime = right.meta?.exists ? right.meta.mtimeMs : -1
  return rightTime - leftTime || left.name.localeCompare(right.name)
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* handoff_join                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

async function runJoin(ctx, config, args, exec) {
  const agent = exec.agent
  const room = resolveRoom(ctx, config, agent)
  const sessionId = callerSessionId(agent)
  const language = config.promptLanguage

  const displayName = validateName(args.name)
  const doc = validateDocName(args.doc ?? defaultDocName(displayName))
  const content = typeof args.content === 'string' ? args.content : undefined

  const { participants } = await readParticipants(room)
  const self = participants.find((participant) => participant.sessionId === sessionId)

  const sameName = participants.find(
    (participant) => participant.sessionId !== sessionId && comparableText(participant.name) === comparableText(displayName)
  )
  if (sameName) {
    throw new HubError('name_taken', `"${displayName}" is already used by another session; choose a different name.`)
  }

  const owner = participants.find(
    (participant) => participant.sessionId !== sessionId && comparableText(participant.doc) === comparableText(doc)
  )
  if (owner) {
    throw new HubError('doc_taken', `"${doc}" is registered by "${owner.name}"; choose another doc name.`)
  }

  if (content !== undefined) {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > config.maxDocBytes) {
      throw new HubError('doc_too_large', `content is ${bytes} bytes; the configured limit is ${config.maxDocBytes} bytes.`)
    }
  }

  const before = await readDocMeta(room, doc)
  if (content !== undefined) {
    const isMine = self?.doc !== undefined && comparableText(self.doc) === comparableText(doc)
    if (before.exists && !isMine && args.overwrite !== true) {
      throw new HubError('doc_exists', `"${doc}" already exists and is not this session's document; pass overwrite:true or choose another doc name.`)
    }
    await writeDocContent(room, doc, content)
  } else if (!before.exists) {
    throw new HubError('doc_missing', `"${doc}" does not exist; pass content to write it, or create the file with your file tools first.`)
  }

  const now = new Date().toISOString()
  await writeParticipant(room, {
    sessionId,
    name: displayName,
    doc,
    cwd: callerCwd(ctx, agent),
    joinedAt: self?.joinedAt ?? now,
    updatedAt: now
  })

  const meta = await readDocMeta(room, doc)
  const after = await readParticipants(room)
  const peers = after.participants
    .filter((participant) => participant.sessionId !== sessionId)
    .map((participant) => ({
      name: participant.name,
      sessionId: participant.sessionId,
      doc: participant.doc,
      absolute: docPath(room, participant.doc),
      meta: { exists: false }
    }))
  for (const peer of peers) peer.meta = await readDocMeta(room, peer.doc)
  peers.sort(compareDocs)

  const header =
    language === 'en'
      ? `[handoff-hub] Registered\nYou are registered as ${displayName}; document: ${docPath(room, doc)} (${describeMeta(meta, language)}).`
      : `[交接中枢] 已登记\n你已登记为 ${displayName}，文档：${docPath(room, doc)}（${describeMeta(meta, language)}）。`
  const next =
    language === 'en'
      ? 'Next: call handoff_board to review peers, or handoff_nudge to ask them to synchronize now.'
      : '下一步：用 handoff_board 查看同伴，或用 handoff_nudge 让同伴现在同步。'
  const board = boardReport({
    language,
    room,
    self: { sessionId, registered: true, name: displayName, doc, absolute: docPath(room, doc), meta },
    peers,
    unregistered: [],
    warnings: after.warnings
  })
  // Two concurrent joins can pick the same new document; surface the conflict
  // instead of silently letting one roster entry shadow the other.
  const conflicting = after.participants.filter(
    (participant) => participant.sessionId !== sessionId && comparableText(participant.doc) === comparableText(doc)
  )
  const conflictLine =
    conflicting.length === 0
      ? ''
      : language === 'en'
        ? `\n[roster_conflict] ${conflicting.map((participant) => participant.name).join(', ')} also registered "${doc}"; ask that session to choose another document name.`
        : `\n[roster_conflict] ${conflicting.map((participant) => participant.name).join('、')} 也登记了 "${doc}"；请让该会话改用另一个文档名。`
  return `${header}\n\n${board}${conflictLine}\n\n${next}`
}

function describeMeta(meta, language) {
  if (!meta || !meta.exists) return meta?.error ? `${language === 'en' ? 'missing' : '缺失'} (${meta.error})` : language === 'en' ? 'missing' : '缺失'
  return `${formatBytes(meta.bytes)}, ${formatTime(meta.mtimeMs)}`
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* handoff_leave                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

async function runLeave(ctx, config, _args, exec) {
  const agent = exec.agent
  const room = resolveRoom(ctx, config, agent)
  const sessionId = callerSessionId(agent)
  const language = config.promptLanguage
  const { participants } = await readParticipants(room)
  const self = participants.find((participant) => participant.sessionId === sessionId)
  if (!self) {
    return language === 'en'
      ? '[handoff-hub] Not registered\nThis session is not in the handoff room; nothing to remove.'
      : '[交接中枢] 未登记\n本会话不在交接室名单中，无需退出。'
  }
  await removeParticipant(room, sessionId)
  return language === 'en'
    ? `[handoff-hub] Left the handoff room\nRemoved the roster entry for ${self.name}; the document ${docPath(room, self.doc)} was left untouched.`
    : `[交接中枢] 已退出交接室\n已移除 ${self.name} 的登记；文档 ${docPath(room, self.doc)} 保留不动。`
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* handoff_nudge                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

const TARGET_REFUSALS = {
  foreign_workspace: 'target Session belongs to another workspace',
  subagent_session: 'target is a delegated subagent session',
  session_not_found: 'target Session does not exist',
  target_unverified: 'Session storage is unavailable, so the target cannot be verified',
  target_unreadable: 'target Session could not be read'
}

function refusalMessage(code) {
  return `[${code}] ${TARGET_REFUSALS[code] ?? 'target refused'}`
}

async function runNudge(ctx, config, args, exec) {
  const agent = exec.agent
  if (isDelegated(agent)) {
    throw new HubError('subagent_session', 'handoff_nudge must be called from a main session, not from a delegated subagent.')
  }

  const room = resolveRoom(ctx, config, agent)
  const sessionId = callerSessionId(agent)
  const language = config.promptLanguage
  const { participants } = await readParticipants(room)
  const self = participants.find((participant) => participant.sessionId === sessionId)
  const callerName = self?.name ?? `session ${shortId(sessionId)}`
  const includeSelf = args.includeSelf === true

  let delay = config.nudgeDelaySeconds
  if (args.delaySeconds !== undefined) {
    const requested = Number(args.delaySeconds)
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 60) {
      throw new HubError('invalid_delay', 'delaySeconds must be an integer from 1 through 60.')
    }
    delay = requested
  }

  const note = typeof args.note === 'string' ? oneLine(args.note, 500) : ''

  const references = []
  if (args.references !== undefined) {
    if (!Array.isArray(args.references)) {
      throw new HubError('invalid_references', 'references must be an array of file paths when supplied.')
    }
    if (args.references.length > 5) {
      throw new HubError('too_many_references', 'at most 5 references are allowed per nudge.')
    }
    const seen = new Set()
    for (const raw of args.references) {
      const reference = await resolveReference(ctx, agent, raw, config.maxDocBytes)
      if (seen.has(reference.absolute)) continue
      seen.add(reference.absolute)
      references.push(reference)
    }
  }

  let requested
  if (args.targets !== undefined) {
    if (!Array.isArray(args.targets)) {
      throw new HubError('invalid_targets', 'targets must be an array of session ids when supplied.')
    }
    requested = [...new Set(args.targets.map(validateTargetSessionId))]
    if (requested.length === 0) {
      throw new HubError('invalid_targets', 'targets was supplied but contains no usable session id.')
    }
  } else {
    requested = participants.map((participant) => participant.sessionId)
  }
  if (!includeSelf) requested = requested.filter((target) => target !== sessionId)
  requested = [...new Set(requested)]
  if (requested.length === 0) return noPeersReport(language)
  if (requested.length > config.maxRecipients) {
    throw new HubError('too_many_targets', `this nudge would reach ${requested.length} sessions; the configured limit is ${config.maxRecipients}.`)
  }

  // Roster files are ordinary workspace data, so a target is never trusted from
  // the roster alone: the durable Session header must confirm an ordinary,
  // unarchived session in this workspace.
  const callerWorkspace = comparablePath(callerCwd(ctx, agent))
  const audited = []
  const refused = []
  for (const targetId of requested) {
    const check = await auditTarget(ctx, callerWorkspace, targetId)
    if (check.ok) audited.push(targetId)
    else refused.push({ sessionId: targetId, code: check.code || 'target_unverified' })
  }

  const cleaned = config.cleanupEndedTasks ? await cleanupOwnEndedTasks(ctx, sessionId) : 0

  const docs = []
  for (const participant of participants) {
    docs.push({
      name: participant.name,
      sessionId: participant.sessionId,
      doc: participant.doc,
      absolute: docPath(room, participant.doc),
      meta: await readDocMeta(room, participant.doc)
    })
  }
  docs.sort(compareDocs)

  const bySession = new Map(participants.map((participant) => [participant.sessionId, participant]))
  const settled = await Promise.allSettled(
    audited.map(async (targetId) => {
      const target = bySession.get(targetId)
      const targetName = target?.name ?? `session ${shortId(targetId)}`
      const prompt = nudgePrompt({
        language,
        callerName,
        room,
        targetDoc: target ? docPath(room, target.doc) : undefined,
        docs: docs.filter((entry) => entry.sessionId !== targetId),
        references,
        note
      })
      const title = makeScheduleTitle(callerName, targetName, language)
      const entry = await ctx.schedule.create(
        {
          title,
          prompt,
          timing: { kind: 'after', after_seconds: delay },
          target: { kind: 'session', sessionId: targetId }
        },
        sessionId,
        exec.signal
      )
      return {
        sessionId: targetId,
        name: targetName,
        ok: true,
        scheduleId: typeof entry?.id === 'string' ? entry.id : String(entry?.id ?? ''),
        scheduledAt: typeof entry?.scheduledAt === 'string' ? entry.scheduledAt : ''
      }
    })
  )

  const resultsById = new Map()
  settled.forEach((result, index) => {
    const targetId = audited[index]
    if (result.status === 'fulfilled') {
      resultsById.set(targetId, result.value)
    } else {
      resultsById.set(targetId, {
        sessionId: targetId,
        name: bySession.get(targetId)?.name ?? `session ${shortId(targetId)}`,
        ok: false,
        error: describeError(result.reason)
      })
    }
  })
  for (const refusal of refused) {
    resultsById.set(refusal.sessionId, {
      sessionId: refusal.sessionId,
      name: bySession.get(refusal.sessionId)?.name ?? `session ${shortId(refusal.sessionId)}`,
      ok: false,
      error: refusalMessage(refusal.code)
    })
  }

  return nudgeReport({
    language,
    delaySeconds: delay,
    results: requested.map((targetId) => resultsById.get(targetId)).filter(Boolean),
    cleaned
  })
}

function makeScheduleTitle(callerName, targetName, language) {
  const base = language === 'en' ? `${TITLE_MARKER} Handoff sync` : `${TITLE_MARKER} 交接同步`
  const title = `${base} · ${oneLine(callerName, 22)} → ${oneLine(targetName, 22)}`
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`
}

/**
 * Remove this plugin's ended one-shot tasks so repeated nudges do not grow the
 * Host task list without bound. Best effort: a failed sweep never fails a nudge.
 * The Schedule service injects a no-op change notice into every involved live
 * session except the actor, so this sweep is opt-in and passes the caller as the
 * actor.
 */
async function cleanupOwnEndedTasks(ctx, actorSessionId) {
  try {
    const page = await ctx.schedule.list({ active: false, limit: 200 })
    const items = Array.isArray(page?.items) ? page.items : []
    let deleted = 0
    for (const task of items) {
      if (deleted >= 50) break
      if (!task || task.status !== 'ended') continue
      if (typeof task.title !== 'string' || !task.title.startsWith(TITLE_MARKER)) continue
      try {
        await ctx.schedule.edit({ id: task.id, action: 'delete' }, actorSessionId)
        deleted += 1
      } catch {
        /* best effort */
      }
    }
    return deleted
  } catch {
    return 0
  }
}

/**
 * The handoff room on disk plus session/agent helpers. No service calls live
 * here beyond optional, read-only lookups; everything is guarded so a partial
 * room (missing directory, corrupt roster file, deleted doc) degrades into a
 * report instead of an exception.
 */
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { HubError, comparablePath, safeFileKey, writeAtomic } from './util.js'

/** Hidden plugin-owned state directory inside the user-visible room. */
export const HUB_DIRECTORY = '.handoff-hub'

/** Maximum accepted size of one roster JSON file. */
const MAX_ROSTER_BYTES = 64 * 1024

/** Windows device names that cannot be ordinary file names. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** Characters Windows rejects in a file name, plus path separators and controls. */
const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/

export function hubDir(room) {
  return join(room, HUB_DIRECTORY)
}

export function participantsDir(room) {
  return join(hubDir(room), 'participants')
}

export function participantFile(room, sessionId) {
  return join(participantsDir(room), `${safeFileKey(sessionId)}.json`)
}

export function docPath(room, doc) {
  return join(room, doc)
}

/**
 * Resolve the room directory for one caller. A relative `directory` is anchored
 * at the caller's effective working directory, so each workspace owns its room.
 * @param {any} ctx plugin context
 * @param {{directory: string}} config normalized plugin config
 * @param {any} agent calling Agent
 */
export function resolveRoom(ctx, config, agent) {
  if (isAbsolute(config.directory)) return resolve(config.directory)
  const base = callerCwd(ctx, agent)
  if (!base) {
    throw new HubError(
      'workspace_unknown',
      'Cannot resolve a workspace directory for the relative handoff room; configure an absolute `directory` in the plugin config.'
    )
  }
  return resolve(base, config.directory)
}

/** The caller's effective working directory, or an empty string when unknown. */
export function callerCwd(ctx, agent) {
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    const session = agent?.session
    if (workingDirectory && session) {
      const value = workingDirectory.get(session)
      if (typeof value === 'string' && value) return value
    }
  } catch {
    /* optional service; fall through to the recorded header */
  }
  const header = agent?.session?.header
  if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd
  return ''
}

/** The owning session id of a tool call, or a stable failure. */
export function callerSessionId(agent) {
  const id = agent?.session?.id ?? agent?.id
  if (typeof id !== 'string' || !id) {
    throw new HubError('caller_unknown', 'This tool call has no owning session.')
  }
  return id
}

/** Whether a call runs inside a delegated child agent. The durable delegation
 * depth is the same authority the Schedule service uses; `parentSession` is
 * lineage and survives a fork of a root session. */
export function isDelegated(agent) {
  const header = agent?.session?.header
  if (!header || typeof header !== 'object') return false
  return (typeof header.delegationDepth === 'number' ? header.delegationDepth : 0) > 0
}

/** Non-throwing display-name cleanup for values read from disk. */
export function sanitizeName(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return [...text].slice(0, 48).join('')
}

/** Create the room directories. Idempotent. */
export async function ensureRoom(room) {
  await mkdir(participantsDir(room), { recursive: true })
}

/** Normalize and validate a display name. */
export function validateName(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) throw new HubError('invalid_name', 'name must be a non-empty display name (for example: codex).')
  if ([...text].length > 48) throw new HubError('invalid_name', 'name must be at most 48 characters.')
  return text
}

/** Normalize and validate a handoff document file name (single segment, .md). */
export function validateDocName(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new HubError('invalid_doc', 'doc must be a non-empty file name ending in .md.')
  if (text.length > 120) throw new HubError('invalid_doc', 'doc must be at most 120 characters.')
  if (INVALID_FILENAME.test(text) || text.includes('..')) {
    throw new HubError('invalid_doc', 'doc must be a plain file name: no path separators, no "..", no reserved characters.')
  }
  if (text.startsWith('.') || text.endsWith('.') || text.endsWith(' ')) {
    throw new HubError('invalid_doc', 'doc must not start or end with a dot or space.')
  }
  if (!/\.md$/i.test(text)) throw new HubError('invalid_doc', 'doc must end in ".md".')
  if (WINDOWS_RESERVED.test(text)) throw new HubError('invalid_doc', 'doc must not use a reserved Windows device name.')
  return text
}

/** A stable default document name derived from the display name. */
export function defaultDocName(name) {
  const slug = [...String(name ?? '').toLowerCase()]
    .map((character) => (/[\p{L}\p{N}._-]/u.test(character) ? character : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60)
  return `${slug || 'handoff'}.md`
}

/**
 * Read every valid roster entry. Corrupt or oversized files are skipped with a
 * bounded warning; a missing directory is an empty room, not an error.
 * @returns {Promise<{participants: any[], warnings: string[]}>}
 */
export async function readParticipants(room) {
  const directory = participantsDir(room)
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return { participants: [], warnings: [] }
    return { participants: [], warnings: [`cannot read the roster: ${error?.code || error?.name || 'error'}`] }
  }

  const participants = []
  const warnings = []
  let scanned = 0
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    if (scanned >= 64) {
      warnings.push('skipped roster entries beyond the first 64')
      break
    }
    scanned += 1
    const file = join(directory, entry)
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > MAX_ROSTER_BYTES) {
        warnings.push(`skipped roster entry ${entry}: not a regular, small file`)
        continue
      }
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (
        !value ||
        typeof value !== 'object' ||
        value.v !== 1 ||
        typeof value.sessionId !== 'string' ||
        !value.sessionId ||
        typeof value.name !== 'string' ||
        typeof value.doc !== 'string'
      ) {
        warnings.push(`skipped roster entry ${entry}: invalid shape`)
        continue
      }
      const name = sanitizeName(value.name)
      if (!name) {
        warnings.push(`skipped roster entry ${entry}: empty display name`)
        continue
      }
      let doc
      try {
        doc = validateDocName(value.doc)
      } catch {
        warnings.push(`skipped roster entry ${entry}: unsafe document name`)
        continue
      }
      participants.push({ ...value, name, doc })
    } catch (error) {
      warnings.push(`skipped roster entry ${entry}: ${error?.code || error?.name || 'invalid JSON'}`)
    }
  }
  participants.sort((left, right) => left.name.localeCompare(right.name) || left.sessionId.localeCompare(right.sessionId))
  return { participants, warnings }
}

/** Write one roster entry atomically. */
export async function writeParticipant(room, participant) {
  await ensureRoom(room)
  const value = {
    v: 1,
    sessionId: participant.sessionId,
    name: participant.name,
    doc: participant.doc,
    cwd: participant.cwd || '',
    joinedAt: participant.joinedAt,
    updatedAt: participant.updatedAt
  }
  await writeAtomic(participantFile(room, participant.sessionId), `${JSON.stringify(value, null, 2)}\n`)
}

/** Remove one roster entry; the handoff document itself is never touched. */
export async function removeParticipant(room, sessionId) {
  await rm(participantFile(room, sessionId), { force: true })
}

/**
 * Stat one document. Never throws: missing or unreadable files report
 * `exists: false` plus an optional error code.
 */
export async function readDocMeta(room, doc) {
  try {
    const info = await stat(docPath(room, doc))
    if (!info.isFile()) return { exists: false }
    return { exists: true, bytes: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    return { exists: false, error: error?.code || error?.name || 'stat-failed' }
  }
}

/** Write a handoff document atomically. */
export async function writeDocContent(room, doc, content) {
  await ensureRoom(room)
  await writeAtomic(docPath(room, doc), content)
}

/** Validate one explicit session-id target. */
export function validateTargetSessionId(raw) {
  if (typeof raw !== 'string') throw new HubError('invalid_target', 'target session ids must be strings.')
  const text = raw.trim()
  if (!text) throw new HubError('invalid_target', 'target session ids must be non-empty strings.')
  if (text.length > 200 || /[\u0000-\u001f\s]/.test(text)) {
    throw new HubError('invalid_target', 'target session ids must be at most 200 characters with no whitespace.')
  }
  return text
}

/**
 * Validate one delivery target against durable Session storage. Roster files
 * live in the workspace and can be edited like any other file, so a reminder
 * target is never trusted from the roster alone: the stored Session header must
 * exist, must not be a delegated child, and must belong to the caller's
 * workspace.
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export async function auditTarget(ctx, callerWorkspace, sessionId) {
  const persistence = ctx.get?.('sessionPersistence')
  if (!persistence || typeof persistence.stat !== 'function') {
    return { ok: false, code: 'target_unverified' }
  }
  let stored
  try {
    stored = await persistence.stat(sessionId)
  } catch (error) {
    return { ok: false, code: error?.code || 'target_unreadable' }
  }
  if (!stored) return { ok: false, code: 'session_not_found' }
  const header = stored.header ?? {}
  if ((typeof header.delegationDepth === 'number' ? header.delegationDepth : 0) > 0) {
    return { ok: false, code: 'subagent_session' }
  }
  if (typeof header.cwd === 'string' && header.cwd && callerWorkspace && comparablePath(header.cwd) !== callerWorkspace) {
    return { ok: false, code: 'foreign_workspace' }
  }
  return { ok: true }
}

/**
 * Resolve one extra "required reading" reference for a nudge. References are
 * pointers only (no content is embedded), but they must stay inside the calling
 * session's workspace even after symlink resolution, be a small text document,
 * and exist.
 * @returns {Promise<{ label: string, absolute: string, bytes: number, mtimeMs: number }>}
 */
export async function resolveReference(ctx, agent, raw, maxBytes) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HubError('invalid_reference', 'each reference must be a non-empty file path.')
  }
  const cwd = callerCwd(ctx, agent)
  if (!cwd) {
    throw new HubError('workspace_unknown', 'Cannot resolve a reference without a session working directory.')
  }
  const candidate = isAbsolute(raw.trim()) ? resolve(raw.trim()) : resolve(cwd, raw.trim())
  if (!insideDirectory(cwd, candidate)) {
    throw new HubError('reference_outside_workspace', `reference "${raw}" is outside the calling session's workspace.`)
  }
  let actual
  try {
    actual = await realpath(candidate)
  } catch {
    throw new HubError('reference_missing', `reference "${raw}" does not exist or cannot be read.`)
  }
  let root
  try {
    root = await realpath(cwd)
  } catch {
    root = resolve(cwd)
  }
  if (!insideDirectory(root, actual)) {
    throw new HubError('reference_outside_workspace', `reference "${raw}" resolves outside the calling session's workspace.`)
  }
  const info = await stat(actual)
  if (!info.isFile()) throw new HubError('invalid_reference', `reference "${raw}" is not a regular file.`)
  if (info.size > maxBytes) {
    throw new HubError('reference_too_large', `reference "${raw}" is ${info.size} bytes; the limit is ${maxBytes}.`)
  }
  if (!['.md', '.markdown', '.txt'].includes(extname(actual).toLowerCase())) {
    throw new HubError('invalid_reference', `reference "${raw}" must be a .md, .markdown, or .txt file.`)
  }
  return {
    label: relative(root, actual) || basename(actual),
    absolute: actual,
    bytes: info.size,
    mtimeMs: info.mtimeMs
  }
}

function insideDirectory(base, candidate) {
  const root = resolve(base)
  const value = resolve(candidate)
  const rel = relative(root, value)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
export async function listLiveSessions(ctx, agent, room, participants) {
  try {
    const agents = ctx.get?.('agents')
    if (!agents || typeof agents.list !== 'function') return []
    const caller = callerSessionId(agent)
    const cwd = comparablePath(callerCwd(ctx, agent))
    if (!cwd) return []
    const titles = ctx.get?.('sessionTitle')
    const registered = new Set(participants.map((participant) => participant.sessionId))
    const found = []
    for (const other of agents.list()) {
      if (!other || other === agent || other.id === caller || registered.has(other.id)) continue
      const header = other.session?.header
      if (!header || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) continue
      const otherCwd = comparablePath(callerCwd(ctx, other))
      if (!otherCwd || otherCwd !== cwd) continue
      let title
      try {
        const snapshot = titles?.get?.(other.session)
        if (snapshot && typeof snapshot.title === 'string' && snapshot.title) title = snapshot.title
      } catch {
        /* optional service */
      }
      found.push({
        sessionId: other.id,
        title,
        running: other.status === 'running',
        preset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined
      })
      if (found.length >= 16) break
    }
    found.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    return found
  } catch {
    return []
  }
}

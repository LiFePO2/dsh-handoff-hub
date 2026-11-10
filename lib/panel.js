/**
 * Local management API for the Handoff Hub panel.
 *
 * Routes are registered on the DSH web server under `/handoff-hub`:
 *   GET  /handoff-hub/state   roster, documents, live sessions, auto-remind status
 *   POST /handoff-hub/action  nudge | remove | invite | auto
 *
 * The browser page calls these with the same-origin cookie; the handler also
 * enforces loopback peers and a custom header on writes, so a random web page
 * cannot drive the local roster.
 */
import { isAbsolute, resolve } from 'node:path'
import { comparablePath, shortId } from './util.js'
import {
  auditTarget,
  docPath,
  readDocMeta,
  readParticipants,
  removeParticipant,
  validateTargetSessionId
} from './room.js'
import { invitePrompt, panelNudgePrompt } from './prompts.js'

const BODY_LIMIT = 32 * 1024
const ROUTE_PREFIX = '/handoff-hub'

class PanelError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Register the routes; returns a disposer. A missing web server is a no-op. */
export function registerPanelRoutes(ctx, config, autoRemind) {
  const web = ctx.get?.('webServer')
  if (!web || typeof web.register !== 'function') return () => {}
  try {
    return web.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createPanelHandler(ctx, config, autoRemind)
    })
  } catch (error) {
    warn(ctx, `panel routes were not registered: ${error?.code || error?.message || error}`)
    return () => {}
  }
}

export function createPanelHandler(ctx, config, autoRemind) {
  return (request, response) => {
    void handle(request, response, ctx, config, autoRemind).catch((error) => {
      if (!response.headersSent) {
        const known = error instanceof PanelError
        sendJson(response, known ? error.status : error?.code ? 400 : 500, {
          ok: false,
          error: {
            code: known ? error.code : error?.code || 'internal',
            message: known ? error.message : error?.message || 'internal error'
          }
        })
      } else {
        try {
          response.end()
        } catch {
          /* socket already gone */
        }
      }
    })
  }
}

async function handle(request, response, ctx, config, autoRemind) {
  if (!isLoopback(request)) throw new PanelError('loopback_only', 'only loopback clients may use this API', 403)
  const url = new URL(request.url || '/', 'http://localhost')
  if (url.pathname === `${ROUTE_PREFIX}/state` && request.method === 'GET') {
    return sendJson(response, 200, await buildPanelState(ctx, config, autoRemind))
  }
  if (url.pathname === `${ROUTE_PREFIX}/action` && request.method === 'POST') {
    if (request.headers['x-handoff-hub'] !== '1') {
      throw new PanelError('missing_header', 'missing x-handoff-hub header', 403)
    }
    const body = await readJson(request)
    return sendJson(response, 200, await runPanelAction(ctx, config, autoRemind, body))
  }
  throw new PanelError('not_found', 'unknown route', 404)
}

export async function buildPanelState(ctx, config, autoRemind) {
  const workspace = await chooseWorkspace(ctx, config)
  if (!workspace) throw new PanelError('workspace_unknown', 'cannot resolve a workspace for the panel', 409)
  const room = resolvePanelRoom(workspace, config)
  const { participants, warnings } = await readParticipants(room)
  const live = listLiveAgents(ctx, workspace)
  const liveIds = new Set(live.map((entry) => entry.sessionId))
  const registered = new Set(participants.map((entry) => entry.sessionId))

  const members = []
  for (const participant of participants) {
    members.push({
      sessionId: participant.sessionId,
      name: participant.name,
      doc: participant.doc,
      absolute: docPath(room, participant.doc),
      meta: await readDocMeta(room, participant.doc),
      live: liveIds.has(participant.sessionId)
    })
  }

  return {
    ok: true,
    workspace,
    room,
    autoRemind: autoRemind?.status?.() ?? { ...config.autoRemind },
    participants: members,
    unregistered: live.filter((entry) => !registered.has(entry.sessionId)),
    warnings
  }
}

async function runPanelAction(ctx, config, autoRemind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PanelError('invalid_body', 'action body must be an object')
  }
  const workspace = await chooseWorkspace(ctx, config)
  if (!workspace) throw new PanelError('workspace_unknown', 'cannot resolve a workspace for the panel', 409)
  const room = resolvePanelRoom(workspace, config)
  const action = body.action

  if (action === 'auto') {
    if (typeof body.enabled !== 'boolean') throw new PanelError('invalid_body', 'enabled must be a boolean')
    const status = autoRemind.setEnabled(body.enabled)
    return { ok: true, autoRemind: status }
  }

  if (action === 'nudge') return await nudgeFromPanel(ctx, config, room, workspace, body)
  if (action === 'remove') return await removeFromPanel(room, body)
  if (action === 'invite') return await inviteFromPanel(ctx, config, room, workspace, body)
  throw new PanelError('unknown_action', `unknown action: ${String(action)}`)
}

async function nudgeFromPanel(ctx, config, room, workspace, body) {
  const { participants } = await readParticipants(room)
  if (participants.length === 0) throw new PanelError('no_participants', 'the group has no registered sessions', 409)

  let targets = participants
  if (body.targetSessionId !== undefined) {
    const targetId = validateTargetSessionId(body.targetSessionId)
    targets = participants.filter((entry) => entry.sessionId === targetId)
    if (targets.length === 0) throw new PanelError('target_not_registered', 'that session is not registered', 404)
  }

  const language = config.promptLanguage
  const title = language === 'en' ? '[handoff-hub] Panel sync · now' : '[handoff-hub] 面板提醒 · 现在同步'
  const delay = Number.isSafeInteger(config.nudgeDelaySeconds) && config.nudgeDelaySeconds > 0
    ? Math.min(60, config.nudgeDelaySeconds)
    : 1

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const expected = comparablePath(target.cwd || workspace)
      const audit = await auditTarget(ctx, expected, target.sessionId)
      if (!audit.ok) throw new PanelError('target_refused', `target refused: ${audit.code || 'unknown'}`, 409)

      const docs = []
      for (const peer of participants) {
        if (peer.sessionId === target.sessionId) continue
        docs.push({
          name: peer.name,
          sessionId: peer.sessionId,
          doc: peer.doc,
          absolute: docPath(room, peer.doc),
          meta: await readDocMeta(room, peer.doc)
        })
      }

      const prompt = panelNudgePrompt({
        language,
        room,
        docs,
        targetDoc: docPath(room, target.doc)
      })
      const receipt = await ctx.schedule.create(
        {
          title,
          prompt,
          timing: { kind: 'after', after_seconds: delay },
          target: { kind: 'session', sessionId: target.sessionId }
        },
        undefined,
        AbortSignal.timeout(15_000)
      )
      return { sessionId: target.sessionId, name: target.name, scheduleId: receipt?.id }
    })
  )

  const delivered = []
  const failed = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') delivered.push(result.value)
    else {
      failed.push({
        sessionId: targets[index].sessionId,
        name: targets[index].name,
        error: result.reason?.code || result.reason?.message || 'delivery failed'
      })
    }
  })
  return { ok: delivered.length > 0, delivered, failed }
}

async function removeFromPanel(room, body) {
  const targetId = validateTargetSessionId(body.targetSessionId)
  const { participants } = await readParticipants(room)
  if (!participants.some((entry) => entry.sessionId === targetId)) {
    throw new PanelError('target_not_registered', 'that session is not registered', 404)
  }
  await removeParticipant(room, targetId)
  return { ok: true, removed: targetId }
}

async function inviteFromPanel(ctx, config, room, workspace, body) {
  const targetId = validateTargetSessionId(body.targetSessionId)
  const { participants } = await readParticipants(room)
  if (participants.some((entry) => entry.sessionId === targetId)) {
    throw new PanelError('already_registered', 'that session is already registered', 409)
  }
  const live = listLiveAgents(ctx, workspace)
  if (!live.some((entry) => entry.sessionId === targetId)) {
    throw new PanelError('target_not_live', 'that session is not a live session in this workspace', 404)
  }

  const audit = await auditTarget(ctx, comparablePath(workspace), targetId)
  if (!audit.ok) throw new PanelError('target_refused', `target refused: ${audit.code || 'unknown'}`, 409)

  const name = `session-${shortId(targetId)}`
  const doc = `handoff-${shortId(targetId)}.md`
  const language = config.promptLanguage
  const title = language === 'en' ? '[handoff-hub] Join the handoff group' : '[handoff-hub] 邀请加入对话组'
  const prompt = invitePrompt({ language, room, name, doc })
  const receipt = await ctx.schedule.create(
    {
      title,
      prompt,
      timing: { kind: 'after', after_seconds: 1 },
      target: { kind: 'session', sessionId: targetId }
    },
    undefined,
    AbortSignal.timeout(15_000)
  )
  return { ok: true, invited: targetId, scheduleId: receipt?.id }
}

/**
 * Pick the workspace whose handoff room actually has members. The deployment
 * fallback (`workingDirectory.defaultDirectory`) is the profile directory, not
 * the user's project, so live Session cwds come first.
 */
async function chooseWorkspace(ctx, config) {
  const workingDirectory = ctx.get?.('workingDirectory')
  const agents = ctx.get?.('agents')?.list?.() ?? []
  const candidates = []
  for (const agent of agents) {
    const cwd = workingDirectory?.get?.(agent.session)
    if (typeof cwd === 'string' && cwd) {
      const value = resolve(cwd)
      if (!candidates.includes(value)) candidates.push(value)
    }
  }
  const fallback = workingDirectory?.defaultDirectory
  if (typeof fallback === 'string' && fallback) {
    const value = resolve(fallback)
    if (!candidates.includes(value)) candidates.push(value)
  }
  if (candidates.length === 0) return undefined

  let best = candidates[0]
  let bestCount = -1
  for (const candidate of candidates) {
    try {
      const { participants } = await readParticipants(resolvePanelRoom(candidate, config))
      if (participants.length > bestCount) {
        best = candidate
        bestCount = participants.length
      }
      if (bestCount > 0) break
    } catch {
      /* a candidate without a readable room is not fatal */
    }
  }
  return best
}

function resolvePanelRoom(workspace, config) {
  return isAbsolute(config.directory) ? resolve(config.directory) : resolve(workspace, config.directory)
}

function listLiveAgents(ctx, workspace) {
  const agents = ctx.get?.('agents')
  const workingDirectory = ctx.get?.('workingDirectory')
  const titles = ctx.get?.('sessionTitle')
  if (!agents || typeof agents.list !== 'function') return []
  const expected = comparablePath(workspace)
  const found = []
  for (const agent of agents.list()) {
    const header = agent?.session?.header
    if (!header) continue
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) continue
    const cwd = workingDirectory?.get?.(agent.session)
    if (!cwd || comparablePath(cwd) !== expected) continue
    let title
    try {
      const snapshot = titles?.get?.(agent.session)
      if (snapshot && typeof snapshot.title === 'string' && snapshot.title) title = snapshot.title
    } catch {
      /* optional service */
    }
    found.push({
      sessionId: agent.id,
      title,
      running: agent.status === 'running'
    })
    if (found.length >= 32) break
  }
  found.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  return found
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new PanelError('body_too_large', 'request body is too large', 413)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PanelError('invalid_body', 'action body must be an object')
    }
    return value
  } catch (error) {
    if (error instanceof PanelError) throw error
    throw new PanelError('invalid_json', 'request body is not valid JSON')
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(text)
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`handoff-hub: ${message}`)
  } catch {
    /* logging must never fail */
  }
}

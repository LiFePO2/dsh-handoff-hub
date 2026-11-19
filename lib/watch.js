/**
 * Optional directory watcher: after a quiet debounce window, ask every registered
 * session to read the changed handoff documents. It is polling-based on purpose —
 * `fs.watch` is inconsistent across platforms and can emit duplicate/missing
 * events. The watcher is opt-in, unrefs its timers, and every callback is guarded.
 *
 * Robustness rules added after the 2026-11-12 incident:
 * - the room is re-resolved from the live workspaces until a room with roster
 *   members is found (never trust a single early `agents.list()` snapshot);
 * - a missing room is reported as an error and retried, not treated as "no
 *   changes" forever;
 * - watcher health (room, last scan, last error, pending) is persisted under
 *   `.handoff-hub/watcher-state.json` and surfaced by the board/panel;
 * - a delivery batch is only cleared after a successful send;
 * - overdue handoff tasks with no receipt are retried with a bounded backoff,
 *   so a Schedule delivery failure no longer needs an unrelated external drive.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { comparablePath, comparableText, describeError, writeAtomic } from './util.js'
import { HUB_DIRECTORY, auditTarget, docPath, readDocMeta, readParticipants } from './room.js'
import { autoReminderPrompt } from './prompts.js'

const MAX_WATCHED_DOCS = 200
const WATCH_STATE_VERSION = 1
const WATCH_STATE_FILE = 'watcher-state.json'
const TITLE_MARKER = '[handoff-hub]'
const SWEEP_EVERY_POLLS = 12
const SCAN_TIMEOUT_MS = 15_000
const DELIVERY_TIMEOUT_MS = 30_000
const RETRY_TIMEOUT_MS = 25_000
const MAX_SWEEP_ATTEMPTS_PER_POLL = 3
/** Only a reminder that is still genuinely unsent may be merged into; an
 * overdue task is either executing or stuck and must not absorb new content. */
const MERGE_GRACE_MS = 15_000
/** Bound the combined prompt so repeated merges cannot grow a task without limit. */
const MAX_MERGED_PROMPT_CHARS = 60_000

/** Race a promise against a hard timeout so one wedged Host call cannot stop the loop. */
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Workspaces the watcher may belong to: every live Agent cwd first (they are the
 * real workspaces), then the deployment default directory (the profile dir).
 * @returns {string[]} absolute candidate directories, de-duplicated
 */
export function candidateWorkspaces(ctx, config) {
  const values = []
  const push = (value) => {
    if (typeof value !== 'string' || !value) return
    const resolved = resolve(value)
    if (!values.includes(resolved)) values.push(resolved)
  }
  const workingDirectory = ctx.get?.('workingDirectory')
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
    try {
      const cwd = workingDirectory?.get?.(agent.session)
      if (typeof cwd === 'string' && cwd) push(cwd)
    } catch {
      /* optional service */
    }
  }
  if (typeof workingDirectory?.defaultDirectory === 'string') push(workingDirectory.defaultDirectory)
  return values
}

/**
 * Resolve the handoff room the watcher should observe.
 *
 * An absolute `directory` is authoritative. A relative one is resolved against
 * the candidate workspaces and the room with the most roster members wins; a
 * room without members is not watched yet (the caller retries every poll), which
 * prevents a cold start — where no Agent exists — from binding to the profile
 * directory and staying mute forever.
 * @returns {Promise<string|undefined>}
 */
export async function resolveWatchRoom(ctx, config) {
  if (isAbsolute(config.directory)) return resolve(config.directory)
  let best
  let bestCount = -1
  for (const workspace of candidateWorkspaces(ctx, config)) {
    const room = resolve(workspace, config.directory)
    try {
      const info = await stat(room)
      if (!info.isDirectory()) continue
      const { participants } = await readParticipants(room)
      if (participants.length > bestCount) {
        best = room
        bestCount = participants.length
      }
    } catch {
      /* a candidate without a readable room is not fatal */
    }
  }
  return bestCount > 0 ? best : undefined
}

/** Snapshot top-level `.md` documents as name -> { mtimeMs, size }. */
export async function scanRoomDocs(room) {
  const snapshot = new Map()
  let entries
  try {
    entries = await readdir(room)
  } catch (error) {
    if (error?.code === 'ENOENT') return snapshot
    throw error
  }
  for (const name of entries.sort()) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue
    try {
      const info = await stat(join(room, name))
      if (info.isFile()) snapshot.set(name, { mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      /* a file can disappear between readdir and stat */
    }
    if (snapshot.size >= MAX_WATCHED_DOCS) break
  }
  return snapshot
}

/**
 * Scan while distinguishing "room missing" from "room empty". Both produce an
 * empty snapshot, but only the first is an error worth surfacing and retrying.
 * @returns {Promise<{ exists: boolean, snapshot: Map<string, { mtimeMs: number, size: number }>, error?: string }>}
 */
export async function scanRoomDocsStatus(room) {
  try {
    const info = await stat(room)
    if (!info.isDirectory()) return { exists: false, snapshot: new Map(), error: 'room_not_directory' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, snapshot: new Map() }
    return { exists: true, snapshot: new Map(), error: describeError(error) }
  }
  try {
    return { exists: true, snapshot: await scanRoomDocs(room) }
  } catch (error) {
    return { exists: true, snapshot: new Map(), error: describeError(error) }
  }
}

/** Names added, removed, or changed between two snapshots. */
export function diffRoomDocs(previous, current) {
  const changed = new Set()
  for (const [name, meta] of current) {
    const before = previous?.get(name)
    if (!before || before.mtimeMs !== meta.mtimeMs || before.size !== meta.size) changed.add(name)
  }
  for (const name of previous?.keys() ?? []) {
    if (!current.has(name)) changed.add(name)
  }
  return [...changed].sort()
}

/** Read the persisted watcher state, tolerating a missing/torn file. */
async function readWatchState(room) {
  try {
    const text = await readFile(join(room, HUB_DIRECTORY, WATCH_STATE_FILE), 'utf8')
    const value = JSON.parse(text)
    return value && value.v === WATCH_STATE_VERSION ? value : undefined
  } catch {
    return undefined
  }
}

/** Convert a persisted snapshot object back into the Map form used by diffRoomDocs. */
function snapshotFromState(value) {
  const snapshot = new Map()
  if (!value || typeof value !== 'object') return snapshot
  for (const [name, meta] of Object.entries(value)) {
    if (!meta || typeof meta !== 'object') continue
    const mtimeMs = Number(meta.mtimeMs)
    const size = Number(meta.size)
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) continue
    snapshot.set(name, { mtimeMs, size })
  }
  return snapshot
}

/**
 * Start the watcher. Returns a disposer that clears both timers and stops all
 * further work. A disabled config returns a no-op disposer and registers no
 * timers at all.
 * @param {any} ctx plugin context
 * @param {any} config normalized plugin config
 * @param {(state: any) => void} [onState] health callback (board/panel)
 */
export function startAutoReminder(ctx, config, onState = () => {}) {
  const auto = config.autoRemind
  if (!auto || auto.enabled !== true) return () => {}

  const pollMs = Math.max(1, Number(auto.pollSeconds) || 10) * 1000
  const debounceMs = Math.max(0, Number(auto.debounceSeconds) || 0) * 1000
  const state = {
    v: WATCH_STATE_VERSION,
    enabled: true,
    startedAt: new Date().toISOString(),
    room: undefined,
    roomExists: false,
    lastScanAt: undefined,
    lastChangeAt: undefined,
    lastFireAt: undefined,
    lastDeliveryAt: undefined,
    lastError: undefined,
    docCount: 0,
    pending: 0,
    retries: {}
  }
  let baseline = new Map()
  let pending = new Set()
  let debounceTimer
  let pollTimer
  let polling = false
  let firing = false
  let stopped = false
  let pollCount = 0
  let lastPersistedAt = 0

  const publish = (patch = {}) => {
    if (patch && typeof patch === 'object') Object.assign(state, patch)
    try {
      onState({ ...state, retries: { ...state.retries } })
    } catch {
      /* a health callback must never fail the watcher */
    }
  }

  const persist = async (force = false) => {
    if (!state.room) return
    const now = Date.now()
    if (!force && now - lastPersistedAt < 15_000) return
    lastPersistedAt = now
    try {
      const snapshot = {}
      for (const [name, meta] of [...baseline].slice(0, MAX_WATCHED_DOCS)) {
        snapshot[name] = { mtimeMs: meta.mtimeMs, size: meta.size }
      }
      const value = {
        ...state,
        snapshot,
        pending: [...pending].slice(0, 50)
      }
      await writeAtomic(join(state.room, HUB_DIRECTORY, WATCH_STATE_FILE), `${JSON.stringify(value, null, 2)}\n`)
    } catch {
      /* state is best effort; a write failure must not stop scanning */
    }
  }

  const arm = (delayMs = debounceMs) => {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void fire()
    }, Math.max(0, delayMs))
    debounceTimer.unref?.()
  }

  const poll = async () => {
    if (stopped || polling) return
    polling = true
    try {
      pollCount += 1
      if (!state.room || !state.roomExists) {
        const room = await resolveWatchRoom(ctx, config)
        if (room !== state.room) {
          if (room) {
            const prior = await readWatchState(room)
            const status = await scanRoomDocsStatus(room)
            state.room = room
            baseline = status.snapshot
            publish({
              room,
              roomExists: status.exists,
              docCount: status.snapshot.size,
              lastScanAt: new Date().toISOString(),
              lastError: status.exists ? undefined : `room_missing:${room}`
            })
            // Catch up changes that happened while the plugin was stopped, so a
            // restart no longer silently swallows a change window.
            if (prior?.snapshot && auto.catchUp !== false) {
              const changed = diffRoomDocs(snapshotFromState(prior.snapshot), baseline)
              if (changed.length > 0) {
                for (const name of changed) pending.add(name)
                publish({ lastChangeAt: new Date().toISOString(), pending: pending.size, caughtUp: changed.length })
                arm(1000)
              }
            }
          } else {
            publish({
              room: undefined,
              roomExists: false,
              lastScanAt: new Date().toISOString(),
              lastError: 'room_unresolved'
            })
          }
        }
      } else {
        const status = await withTimeout(scanRoomDocsStatus(state.room), SCAN_TIMEOUT_MS, 'auto-remind scan timed out')
        publish({
          roomExists: status.exists,
          lastScanAt: new Date().toISOString(),
          ...(status.error === undefined ? {} : { lastError: status.error })
        })
        if (!status.exists) {
          publish({ lastError: `room_missing:${state.room}` })
        } else {
          const changed = diffRoomDocs(baseline, status.snapshot)
          baseline = status.snapshot
          publish({ roomExists: true, docCount: baseline.size })
          if (changed.length > 0) {
            for (const name of changed) pending.add(name)
            publish({ lastChangeAt: new Date().toISOString(), pending: pending.size })
            arm()
          }
        }
      }
      if (pollCount % SWEEP_EVERY_POLLS === 0) await sweepUndelivered()
      await persist()
    } catch (error) {
      if (!stopped) {
        publish({ lastError: `scan: ${describeError(error)}` })
        warn(ctx, `auto-remind scan failed: ${describeError(error)}`)
      }
    } finally {
      polling = false
    }
  }

  const fire = async () => {
    if (stopped || firing) return
    const changed = [...pending].sort()
    if (changed.length === 0) return
    const batch = new Set(changed)
    pending = new Set()
    firing = true
    try {
      await withTimeout(
        deliverAutoReminder(ctx, config, state.room, changed),
        DELIVERY_TIMEOUT_MS,
        'auto-remind delivery timed out'
      )
      publish({ lastFireAt: new Date().toISOString(), lastDeliveryAt: new Date().toISOString(), pending: pending.size })
      await persist(true)
    } catch (error) {
      // Never lose a batch: put it back and retry after another quiet window.
      for (const name of batch) pending.add(name)
      publish({ lastError: `fire: ${describeError(error)}`, pending: pending.size })
      warn(ctx, `auto-remind delivery failed: ${describeError(error)}`)
      arm(Math.max(debounceMs, 30_000))
    } finally {
      firing = false
    }
  }

  /**
   * Retry this plugin's own overdue tasks that never received a receipt. The
   * Schedule runtime excludes failed tasks from its next timer, so without this
   * sweep a delivery failure waits for an unrelated external drive forever.
   */
  const sweepUndelivered = async () => {
    const retry = config.autoNudgeRetry
    if (!retry || retry.enabled !== true) return
    if (typeof ctx.schedule?.run !== 'function') return
    let page
    try {
      page = await ctx.schedule.list({ active: true, limit: 200 })
    } catch (error) {
      warn(ctx, `auto-remind retry sweep could not list tasks: ${describeError(error)}`)
      return
    }
    const items = Array.isArray(page?.items) ? page.items : []
    const now = Date.now()
    let attempted = 0
    for (const task of items) {
      if (attempted >= MAX_SWEEP_ATTEMPTS_PER_POLL) break
      if (!task || typeof task.id !== 'string' || !String(task.title || '').startsWith(TITLE_MARKER)) continue
      if (task.status !== 'active' || task.lastDelivery) continue
      const scheduled = Date.parse(task.scheduledAt || task.record?.scheduledAt || '')
      if (!Number.isFinite(scheduled) || scheduled + retry.graceSeconds * 1000 > now) continue
      const prior = state.retries[task.id] ?? { attempts: 0, lastAt: 0 }
      if (prior.attempts >= retry.maxAttempts) continue
      if (now - prior.lastAt < retry.cooldownSeconds * 1000) continue
      attempted += 1
      try {
        const result = await withTimeout(
          ctx.schedule.run({ id: task.id }, AbortSignal.timeout(20_000)),
          RETRY_TIMEOUT_MS,
          'retry timed out'
        )
        if (result && result.code === 'schedule_execution_pending') {
          state.retries[task.id] = { attempts: prior.attempts, lastAt: now, lastError: 'execution_pending' }
        } else {
          delete state.retries[task.id]
          publish({ lastDeliveryAt: new Date().toISOString() })
        }
      } catch (error) {
        state.retries[task.id] = {
          attempts: (prior.attempts ?? 0) + 1,
          lastAt: now,
          lastError: describeError(error)
        }
        publish({ lastError: `retry ${task.id}: ${state.retries[task.id].lastError}` })
        warn(ctx, `auto-remind retry ${task.id} failed (${state.retries[task.id].attempts}/${retry.maxAttempts}): ${state.retries[task.id].lastError}`)
      }
    }
    await persist(true)
  }

  void (async () => {
    try {
      await poll()
    } catch {
      /* poll already reports and retries */
    }
    if (stopped) return
    pollTimer = setInterval(() => {
      void poll()
    }, pollMs)
    pollTimer.unref?.()
    try {
      ctx.logger?.info?.(`handoff-hub: auto-remind watching ${state.room ?? '(unresolved room, retrying)'} (debounce ${auto.debounceSeconds}s, poll ${auto.pollSeconds}s)`)
    } catch {
      /* logging must never fail */
    }
  })()

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    if (pollTimer) clearInterval(pollTimer)
    debounceTimer = undefined
    pollTimer = undefined
  }
}

/**
 * Runtime controller for the watcher. The UI can toggle it without editing the
 * profile patch; the change lasts until the plugin is reloaded.
 */
export function createAutoReminderController(ctx, config) {
  let stop = () => {}
  let current = { ...config.autoRemind }
  let watcher = {
    v: WATCH_STATE_VERSION,
    enabled: false,
    room: undefined,
    roomExists: false,
    lastError: undefined
  }

  const restart = () => {
    stop()
    stop = () => {}
    watcher = {
      ...watcher,
      enabled: current.enabled,
      startedAt: new Date().toISOString(),
      lastError: current.enabled ? undefined : 'disabled'
    }
    if (!current.enabled) return
    stop = startAutoReminder(ctx, { ...config, autoRemind: { ...current } }, (next) => {
      watcher = next
    })
  }

  restart()

  return {
    status() {
      return { ...current, watcher: { ...watcher, retries: { ...(watcher.retries ?? {}) } } }
    },
    setEnabled(enabled) {
      current = { ...current, enabled: enabled === true }
      config.autoRemind.enabled = current.enabled
      restart()
      return { ...current }
    },
    stop() {
      stop()
      stop = () => {}
    }
  }
}

const AUTO_TITLE_PREFIXES = ['[handoff-hub] 自动同步', '[handoff-hub] Auto sync']

/**
 * Initial hold for a fresh automatic reminder: the existing merge window. A
 * task created inside an active cooldown is instead scheduled for the remaining
 * cooldown in `deliverAutoReminder`.
 */
export function autoInitialDelaySeconds(config) {
  return Math.max(1, Math.min(600, Number(config.autoRemind?.mergeSeconds) || 1))
}

function archivedSessions(ctx) {
  try {
    const list = ctx.get?.('workspaceRegistry')?.archivedSessionIds
    return new Set(Array.isArray(list) ? list : [])
  } catch {
    return new Set()
  }
}

/**
 * Rolling 24h automatic-reminder usage for one target. Uses the durable
 * Schedule catalog, so it survives a plugin reload. Only confirmed deliveries
 * consume the cap: a queued-but-undelivered task is a failure, not usage.
 */
export async function autoQuotaFor(ctx, targetSessionId, config, ownMtime = 0) {
  const cap = Number.isSafeInteger(config.autoNudgeDailyCap) ? config.autoNudgeDailyCap : 24
  const cooldownMinutes = Number.isFinite(config.autoNudgeCooldownMinutes)
    ? Math.max(0, Math.min(120, config.autoNudgeCooldownMinutes))
    : 10
  const silenceAfter = Number.isSafeInteger(config.autoNudgeSilenceAfter)
    ? Math.max(0, Math.min(10, config.autoNudgeSilenceAfter))
    : 2
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  let used = 0
  let ignored = 0
  let lastDelivered = 0
  let nextAt = 0
  try {
    const page = await ctx.schedule.list({ limit: 200 })
    const items = Array.isArray(page?.items) ? page.items : []
    for (const task of items) {
      if (!task || task.target?.kind !== 'session' || task.target.sessionId !== targetSessionId) continue
      if (!AUTO_TITLE_PREFIXES.some((prefix) => String(task.title || '').startsWith(prefix))) continue
      const delivered = task.lastDelivery?.deliveredAt ? Date.parse(task.lastDelivery.deliveredAt) : 0
      if (delivered && delivered >= now - day) used += 1
      if (delivered > ownMtime) ignored += 1
      if (delivered > lastDelivered) lastDelivered = delivered
      const scheduled = Date.parse(task.scheduledAt || '') || 0
      if (task.status === 'active' && scheduled && (!nextAt || scheduled < nextAt)) nextAt = scheduled
    }
  } catch {
    /* a catalog read failure must not block the reminder path */
  }
  const cooldownEnd = lastDelivered ? lastDelivered + cooldownMinutes * 60 * 1000 : 0
  return {
    used,
    cap,
    cooldownMinutes,
    ignored,
    silent: silenceAfter > 0 && ignored >= silenceAfter,
    nextAt: nextAt || (cooldownEnd > now ? cooldownEnd : 0)
  }
}

/**
 * Every handoff reminder (automatic, manual nudge or panel) that is still
 * unsent. This is the merge source: the previous implementation only looked at
 * `[handoff-hub] 自动同步` tasks, so a manual nudge plus an automatic batch to
 * the same session queued as two separate messages.
 * @returns {Promise<Array<any>>}
 */
export async function pendingHandoffTasks(ctx) {
  try {
    const page = await ctx.schedule.list({ active: true, limit: 200 })
    const items = Array.isArray(page?.items) ? page.items : []
    const now = Date.now()
    return items.filter((task) => {
      if (!task || task.status !== 'active' || task.lastDelivery || task.executionActive) return false
      if (!String(task.title || '').startsWith(TITLE_MARKER)) return false
      if (task.target?.kind !== 'session' || !task.target.sessionId) return false
      const scheduled = Date.parse(task.scheduledAt || task.record?.scheduledAt || '')
      return Number.isFinite(scheduled) && scheduled > now - MERGE_GRACE_MS
    })
  } catch {
    return []
  }
}

/** Append one reminder body to another without duplicating an identical body. */
export function mergePromptText(existing, addition) {
  const base = typeof existing === 'string' ? existing : ''
  const extra = typeof addition === 'string' ? addition : ''
  if (!extra) return base
  if (!base) return extra
  if (base.includes(extra)) return base
  const merged = `${base}\n\n---\n\n${extra}`
  if (merged.length <= MAX_MERGED_PROMPT_CHARS) return merged
  return `${merged.slice(0, MAX_MERGED_PROMPT_CHARS - 160)}\n\n…（合并内容过长，已截断；请以交接室文档的最新内容为准）`
}

/**
 * Create one reminder, or merge it into the earliest still-unsent handoff task
 * for the same target. The keeper may be moved earlier when the new reminder is
 * more urgent than its current schedule; no second task is created while one is
 * pending, so a target never queues a fresh copy behind an old one.
 *
 * @param {any} ctx host context with `schedule`
 * @param {{
 *   targetSessionId: string,
 *   title: string,
 *   prompt: string,
 *   delaySeconds: number,
 *   actorSessionId?: string,
 *   signal?: AbortSignal,
 *   pendingTasks?: Array<any>,
 *   mergeEnabled?: boolean
 * }} options
 * @returns {Promise<{ entry: any, merged: boolean, keeperId?: string, mergeError?: string }>}
 */
export async function scheduleMergedReminder(ctx, options) {
  const targetSessionId = options.targetSessionId
  // Automatic reminders may be deferred to the end of a long cooldown (seconds,
  // not the 1–60 nudge limit), so only enforce a positive integer here.
  const delay = Math.max(1, Math.min(86_400, Math.round(Number(options.delaySeconds) || 1)))
  const pending = Array.isArray(options.pendingTasks) ? options.pendingTasks : await pendingHandoffTasks(ctx)
  const mergeEnabled = options.mergeEnabled !== false
  const now = Date.now()
  const candidates = mergeEnabled
    ? pending.filter((task) => task.target?.sessionId === targetSessionId)
    : []
  if (candidates.length === 0) {
    const entry = await ctx.schedule.create(
      {
        title: options.title,
        prompt: options.prompt,
        timing: { kind: 'after', after_seconds: delay },
        target: { kind: 'session', sessionId: targetSessionId }
      },
      options.actorSessionId,
      options.signal
    )
    return { entry, merged: false }
  }

  candidates.sort((left, right) => {
    const a = Date.parse(left.scheduledAt || left.record?.scheduledAt || '') || now
    const b = Date.parse(right.scheduledAt || right.record?.scheduledAt || '') || now
    return a - b
  })
  const keeper = candidates[0]
  const keeperAt = Date.parse(keeper.scheduledAt || keeper.record?.scheduledAt || '') || now
  const newAt = now + delay * 1000
  const targetAt = Math.max(now + 1000, Math.min(keeperAt, newAt))
  const patch = { prompt: mergePromptText(keeper.prompt, options.prompt) }
  if (targetAt < keeperAt - 500) patch.timing = { kind: 'at', at: new Date(targetAt).toISOString() }
  try {
    const entry = await ctx.schedule.edit(
      { id: keeper.id, action: 'update', patch },
      options.actorSessionId,
      options.signal
    )
    if (!entry || entry.code) throw new Error(entry?.code ? String(entry.code) : 'edit failed')
    return { entry, merged: true, keeperId: keeper.id }
  } catch (error) {
    // Never lose a reminder because a merge edit was rejected; fall back to a
    // separate task and report the merge failure to the watcher log.
    const entry = await ctx.schedule.create(
      {
        title: options.title,
        prompt: options.prompt,
        timing: { kind: 'after', after_seconds: delay },
        target: { kind: 'session', sessionId: targetSessionId }
      },
      options.actorSessionId,
      options.signal
    )
    return { entry, merged: false, mergeError: describeError(error) }
  }
}

async function deliverAutoReminder(ctx, config, room, changedNames) {
  const { participants } = await readParticipants(room)
  if (participants.length === 0) return
  const archived = archivedSessions(ctx)

  const changed = []
  for (const name of changedNames) {
    changed.push({ name, absolute: join(room, name), meta: await readDocMeta(room, name) })
  }

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
  docs.sort((left, right) => {
    const leftTime = left.meta?.exists ? left.meta.mtimeMs : -1
    const rightTime = right.meta?.exists ? right.meta.mtimeMs : -1
    return rightTime - leftTime || left.name.localeCompare(right.name)
  })

  const changedDocs = new Set(changedNames.map((name) => comparableText(name)))
  const authors = new Set(
    participants
      .filter((participant) => changedDocs.has(comparableText(participant.doc)))
      .map((participant) => participant.sessionId)
  )

  // One snapshot for the whole batch: every unsent handoff reminder (manual,
  // panel or automatic) can be the merge keeper for this target.
  const pendingTasks = await pendingHandoffTasks(ctx)

  const fallbackWorkspace = comparablePath(ctx.get?.('workingDirectory')?.defaultDirectory)
  const language = config.promptLanguage
  const baseDelay = autoInitialDelaySeconds(config)
  const signal = AbortSignal.timeout(15_000)

  // Targeted delivery: skip the author, skip archived sessions, and skip peers
  // whose own handoff document is already at least as new as every changed doc.
  const targets = []
  for (const participant of participants) {
    if (authors.has(participant.sessionId)) continue
    if (archived.has(participant.sessionId)) continue
    const own = docs.find((entry) => entry.sessionId === participant.sessionId)
    const ownTime = own?.meta?.exists ? own.meta.mtimeMs : -1
    const relevant = changed.filter((entry) => !entry.meta?.exists || (entry.meta.mtimeMs || 0) > ownTime)
    if (relevant.length === 0) continue
    targets.push({ participant, relevant })
  }
  if (targets.length === 0) {
    info(ctx, `auto-remind: no stale target for ${changed.length} changed document(s)`)
    return
  }

  let created = 0
  let updated = 0
  let capped = 0
  let silenced = 0
  const settled = await Promise.allSettled(
    targets.map(async ({ participant, relevant }) => {
      const expected = comparablePath(participant.cwd || fallbackWorkspace)
      const audit = await auditTarget(ctx, expected, participant.sessionId)
      if (!audit.ok) throw new Error(`[${audit.code || 'target_refused'}] target audit failed for ${participant.name}`)

      const existing = pendingTasks.find((task) => task.target?.sessionId === participant.sessionId)
      const own = docs.find((entry) => entry.sessionId === participant.sessionId)
      const ownTime = own?.meta?.exists ? own.meta.mtimeMs : -1
      const quota = await autoQuotaFor(ctx, participant.sessionId, config, ownTime)
      if (!existing && quota.silent) {
        silenced += 1
        return { silenced: true }
      }
      if (!existing && quota.used >= quota.cap) {
        capped += 1
        return { capped: true }
      }
      let delay = baseDelay
      if (!existing && quota.nextAt) {
        const remaining = Math.ceil((quota.nextAt - Date.now()) / 1000)
        if (remaining > 0) delay = Math.max(1, remaining)
      }

      const merged = []
      for (const entry of relevant) {
        if (!entry.meta?.exists || (entry.meta.mtimeMs || 0) > ownTime) merged.push(entry)
      }
      if (merged.length === 0) return { skipped: true }

      const title = makeTitle(merged.length, language)
      const prompt = autoReminderPrompt({
        language,
        room,
        changed: merged,
        docs: docs.filter((entry) => entry.sessionId !== participant.sessionId),
        targetDoc: docPath(room, participant.doc)
      })
      const outcome = await scheduleMergedReminder(ctx, {
        targetSessionId: participant.sessionId,
        title,
        prompt,
        delaySeconds: delay,
        signal,
        pendingTasks,
        mergeEnabled: true
      })
      if (outcome.mergeError) {
        warn(ctx, `auto-remind merge into ${outcome.keeperId} failed: ${outcome.mergeError}`)
      }
      if (outcome.merged) {
        updated += 1
        return { updated: true }
      }
      created += 1
      return { created: true }
    })
  )

  const failures = settled.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    warn(ctx, `auto-remind: ${failures.length}/${targets.length} stale target(s) refused or undeliverable`)
  }
  info(ctx, `auto-remind: ${updated} merged, ${created} created, ${capped} capped, ${silenced} silenced, ${changed.length} changed document(s)`)
}

function makeTitle(changedCount, language) {
  return language === 'en'
    ? `[handoff-hub] Auto sync · ${changedCount} changed`
    : `[handoff-hub] 自动同步 · ${changedCount} 篇变更`
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`handoff-hub: ${message}`)
  } catch {
    /* logging must never fail a callback */
  }
}

function info(ctx, message) {
  try {
    ctx.logger?.info?.(`handoff-hub: ${message}`)
  } catch {
    /* logging must never fail */
  }
}

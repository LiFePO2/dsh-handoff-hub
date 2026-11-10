/**
 * Optional directory watcher: after a quiet debounce window, ask every registered
 * session to read the changed handoff documents. It is polling-based on purpose —
 * `fs.watch` is inconsistent across platforms and can emit duplicate/missing
 * events. The watcher is opt-in, unrefs its timers, and every callback is guarded.
 */
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { comparablePath, comparableText } from './util.js'
import { auditTarget, docPath, readDocMeta, readParticipants } from './room.js'
import { autoReminderPrompt } from './prompts.js'

const MAX_WATCHED_DOCS = 200

/** Resolve the room a background watcher should observe. */
export function resolveWatchRoom(ctx, config) {
  if (isAbsolute(config.directory)) return resolve(config.directory)
  const workingDirectory = ctx.get?.('workingDirectory')
  // Live Session cwds are the real workspaces; defaultDirectory is the
  // deployment fallback (the profile directory), so try it only last.
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
    try {
      const cwd = workingDirectory?.get?.(agent.session)
      if (typeof cwd === 'string' && cwd) return resolve(cwd, config.directory)
    } catch {
      /* optional fallback */
    }
  }
  const fallback = workingDirectory?.defaultDirectory
  if (typeof fallback === 'string' && fallback) return resolve(fallback, config.directory)
  return undefined
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

/**
 * Start the watcher. Returns a disposer that clears both timers and stops all
 * further work. A disabled config returns a no-op disposer and registers no
 * timers at all.
 */
export function startAutoReminder(ctx, config) {
  const auto = config.autoRemind
  if (!auto || auto.enabled !== true) return () => {}

  const room = resolveWatchRoom(ctx, config)
  if (!room) {
    warn(ctx, 'auto-remind is enabled but no workspace could be resolved; watcher not started')
    return () => {}
  }

  const pollMs = auto.pollSeconds * 1000
  const debounceMs = auto.debounceSeconds * 1000
  const mergeMs = Math.max(0, Number(auto.mergeSeconds) || 0) * 1000
  let baseline = new Map()
  let pending = new Set()
  let debounceTimer
  let pollTimer
  let polling = false
  let firing = false
  let lastDeliveryAt = 0
  let stopped = false

  const arm = (delayMs = debounceMs) => {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void fire()
    }, delayMs)
    debounceTimer.unref?.()
  }

  const poll = async () => {
    if (stopped || polling) return
    polling = true
    try {
      const current = await scanRoomDocs(room)
      const changed = diffRoomDocs(baseline, current)
      baseline = current
      if (changed.length === 0) return
      for (const name of changed) pending.add(name)
      arm()
    } catch (error) {
      if (!stopped) warn(ctx, `auto-remind scan failed: ${error?.code || error?.message || error}`)
    } finally {
      polling = false
    }
  }

  const fire = async () => {
    if (stopped || firing) return
    const wait = Math.max(0, lastDeliveryAt + mergeMs - Date.now())
    if (wait > 0) {
      arm(wait)
      return
    }
    const changed = [...pending].sort()
    pending = new Set()
    if (changed.length === 0) return
    firing = true
    try {
      await deliverAutoReminder(ctx, config, room, changed)
      lastDeliveryAt = Date.now()
    } catch (error) {
      warn(ctx, `auto-remind delivery failed: ${error?.code || error?.message || error}`)
    } finally {
      firing = false
    }
  }

  void (async () => {
    try {
      baseline = await scanRoomDocs(room)
    } catch {
      baseline = new Map()
    }
    if (stopped) return
    pollTimer = setInterval(() => {
      void poll()
    }, pollMs)
    pollTimer.unref?.()
    try {
      ctx.logger?.info?.(`handoff-hub: auto-remind watching ${room} (debounce ${auto.debounceSeconds}s, poll ${auto.pollSeconds}s)`)
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

  const restart = () => {
    stop()
    stop = () => {}
    if (!current.enabled) return
    stop = startAutoReminder(ctx, { ...config, autoRemind: { ...current } })
  }

  restart()

  return {
    status() {
      return { ...current }
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

async function deliverAutoReminder(ctx, config, room, changedNames) {
  const { participants } = await readParticipants(room)
  if (participants.length === 0) return

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

  const fallbackWorkspace = comparablePath(ctx.get?.('workingDirectory')?.defaultDirectory)
  const language = config.promptLanguage
  const delay = Number.isSafeInteger(config.nudgeDelaySeconds) && config.nudgeDelaySeconds > 0
    ? Math.min(60, config.nudgeDelaySeconds)
    : 1
  const signal = AbortSignal.timeout(15_000)

  // Targeted delivery: skip the author and skip peers whose own handoff
  // document is already at least as new as every changed document.
  const targets = []
  for (const participant of participants) {
    if (authors.has(participant.sessionId)) continue
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

  const settled = await Promise.allSettled(
    targets.map(async ({ participant, relevant }) => {
      const expected = comparablePath(participant.cwd || fallbackWorkspace)
      const audit = await auditTarget(ctx, expected, participant.sessionId)
      if (!audit.ok) throw new Error(`[${audit.code || 'target_refused'}] target audit failed`)
      const prompt = autoReminderPrompt({
        language,
        room,
        changed: relevant,
        docs: docs.filter((entry) => entry.sessionId !== participant.sessionId),
        targetDoc: docPath(room, participant.doc)
      })
      await ctx.schedule.create(
        {
          title: makeTitle(relevant.length, language),
          prompt,
          timing: { kind: 'after', after_seconds: delay },
          target: { kind: 'session', sessionId: participant.sessionId }
        },
        undefined,
        signal
      )
    })
  )

  const failures = settled.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    warn(ctx, `auto-remind: ${failures.length}/${targets.length} stale target(s) refused or undeliverable`)
  }
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
    /* logging must never fail a callback */
  }
}

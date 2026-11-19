/**
 * Plugin configuration. The bundle ships no `Config` schema so the entry file
 * stays import-free; `normalizeConfig` applies the same defaults and bounds
 * here, which keeps the plugin loadable by plain Node in tests.
 */

export const DEFAULTS = Object.freeze({
  /** Room directory: absolute, or relative to the calling session's workspace. */
  directory: 'work/handoff',
  /** Delivered reminder language: 'zh' or 'en'. */
  promptLanguage: 'zh',
  /** Delay before a reminder fires, in seconds (Schedule requires >= 1). */
  nudgeDelaySeconds: 1,
  /** Hard cap on recipients per nudge. */
  maxRecipients: 16,
  /** Hard cap on a handoff document written through handoff_join. */
  maxDocBytes: 262144,
  /** Delete this plugin's ended Schedule tasks before creating new ones. Off by
   * default: the Schedule service injects a no-op `[SCHEDULE CHANGE]` notice into
   * every involved live session when a task is deleted. */
  cleanupEndedTasks: false,
  /** Optional directory watcher that nudges registered sessions after changes. */
  autoRemind: Object.freeze({
    enabled: false,
    debounceSeconds: 30,
    pollSeconds: 10,
    mergeSeconds: 60,
    /** Replay changes recorded in watcher-state after a restart instead of
     * silently treating the current directory as the new baseline. */
    catchUp: true
  }),
  /** Minimum minutes between two automatic reminders to one session. */
  autoNudgeCooldownMinutes: 10,
  /** Maximum automatic reminders per session in a rolling 24h window. */
  autoNudgeDailyCap: 24,
  /** Silence auto reminders after this many deliveries with no own-doc update. */
  autoNudgeSilenceAfter: 2,
  /** Merge a new reminder into any unsent handoff reminder for the same target
   * instead of creating a second task (automatic and manual reminders share the
   * queue; this is what keeps two or three messages from piling up). */
  mergePendingReminders: true,
  /** Retry this plugin's own Schedule tasks that are overdue with no receipt. */
  autoNudgeRetry: Object.freeze({
    enabled: true,
    maxAttempts: 3,
    graceSeconds: 120,
    cooldownSeconds: 600
  })
})

const LIMITS = Object.freeze({
  delay: Object.freeze({ min: 1, max: 60 }),
  recipients: Object.freeze({ min: 1, max: 32 }),
  docBytes: Object.freeze({ min: 1024, max: 4 * 1024 * 1024 })
})

/**
 * @param {unknown} raw row config from the profile patch
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const out = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out

  if (typeof raw.directory === 'string' && raw.directory.trim()) {
    out.directory = raw.directory.trim()
  }
  if (raw.promptLanguage === 'en' || raw.promptLanguage === 'zh') {
    out.promptLanguage = raw.promptLanguage
  }

  const delay = Number(raw.nudgeDelaySeconds)
  if (Number.isSafeInteger(delay) && delay >= LIMITS.delay.min && delay <= LIMITS.delay.max) {
    out.nudgeDelaySeconds = delay
  }

  const recipients = Number(raw.maxRecipients)
  if (Number.isSafeInteger(recipients) && recipients >= LIMITS.recipients.min && recipients <= LIMITS.recipients.max) {
    out.maxRecipients = recipients
  }

  const docBytes = Number(raw.maxDocBytes)
  if (Number.isSafeInteger(docBytes) && docBytes >= LIMITS.docBytes.min && docBytes <= LIMITS.docBytes.max) {
    out.maxDocBytes = docBytes
  }

  if (typeof raw.cleanupEndedTasks === 'boolean') {
    out.cleanupEndedTasks = raw.cleanupEndedTasks
  }

  out.autoRemind = { ...DEFAULTS.autoRemind }
  const auto = raw.autoRemind
  if (auto !== null && typeof auto === 'object' && !Array.isArray(auto)) {
    if (auto.enabled === true || auto.enabled === false) out.autoRemind.enabled = auto.enabled
    const debounce = Number(auto.debounceSeconds)
    if (Number.isSafeInteger(debounce) && debounce >= 1 && debounce <= 600) {
      out.autoRemind.debounceSeconds = debounce
    }
    const poll = Number(auto.pollSeconds)
    if (Number.isSafeInteger(poll) && poll >= 1 && poll <= 120) {
      out.autoRemind.pollSeconds = poll
    }
    const merge = Number(auto.mergeSeconds)
    if (Number.isSafeInteger(merge) && merge >= 0 && merge <= 600) {
      out.autoRemind.mergeSeconds = merge
    }
    if (auto.catchUp === true || auto.catchUp === false) out.autoRemind.catchUp = auto.catchUp
  }

  const cooldown = Number(raw.autoNudgeCooldownMinutes)
  if (Number.isSafeInteger(cooldown) && cooldown >= 0 && cooldown <= 120) {
    out.autoNudgeCooldownMinutes = cooldown
  }
  const cap = Number(raw.autoNudgeDailyCap)
  if (Number.isSafeInteger(cap) && cap >= 4 && cap <= 96) {
    out.autoNudgeDailyCap = cap
  }
  const silenceAfter = Number(raw.autoNudgeSilenceAfter)
  if (Number.isSafeInteger(silenceAfter) && silenceAfter >= 0 && silenceAfter <= 10) {
    out.autoNudgeSilenceAfter = silenceAfter
  }

  if (typeof raw.mergePendingReminders === 'boolean') out.mergePendingReminders = raw.mergePendingReminders

  out.autoNudgeRetry = { ...DEFAULTS.autoNudgeRetry }
  const retry = raw.autoNudgeRetry
  if (retry !== null && typeof retry === 'object' && !Array.isArray(retry)) {
    if (retry.enabled === true || retry.enabled === false) out.autoNudgeRetry.enabled = retry.enabled
    for (const [field, min, max] of [
      ['maxAttempts', 1, 10],
      ['graceSeconds', 0, 3600],
      ['cooldownSeconds', 30, 86400]
    ]) {
      const value = Number(retry[field])
      if (Number.isSafeInteger(value) && value >= min && value <= max) out.autoNudgeRetry[field] = value
    }
  }

  return out
}

/**
 * Small, dependency-free helpers shared by the Handoff Hub plugin.
 * Only Node built-ins are used so the plugin installs and loads without any
 * version-sensitive runtime dependency.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One stable failure shape that tool handlers can render without a stack. */
export class HubError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message short model-facing explanation
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'HubError'
    this.code = code
  }
}

/** Collapse arbitrary text to one bounded line. */
export function oneLine(value, limit = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

/** Shorten a session id for human-facing reports while keeping it recognizable. */
export function shortId(id) {
  const text = String(id ?? '')
  if (text.length <= 16) return text
  if (text.startsWith('session-')) return `…${text.slice(-8)}`
  return `${text.slice(0, 8)}…`
}

/** Render bytes as a compact size. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** Render an epoch-millisecond timestamp as a stable UTC instant. */
export function formatTime(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) return 'unknown'
  try {
    return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')
  } catch {
    return 'unknown'
  }
}

/** Turn any thrown value into one bounded, code-tagged line. */
export function describeError(error) {
  try {
    if (error instanceof HubError) return `[${error.code}] ${error.message}`
    const code = typeof error?.code === 'string' ? error.code : undefined
    const message = error?.message || String(error)
    return code ? `[${code}] ${oneLine(message, 400)}` : oneLine(message, 400)
  } catch {
    return 'unknown error'
  }
}

/** Keep a session id safe as a Windows/POSIX file stem. */
export function safeFileKey(sessionId) {
  const text = String(sessionId ?? '')
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)
  if (!reserved && /^[A-Za-z0-9._-]{1,128}$/.test(text)) return text
  return `h-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`
}

/**
 * Case-folded text for identity comparisons. Names and document names are
 * compared without case on every platform: the common case is NTFS, where they
 * would collide, and a conservative check is safer than a platform split.
 */
export function comparableText(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Write UTF-8 text through a same-directory temporary file and rename, so a
 * reader sees the old complete file or the new complete file, never a prefix.
 * On Windows a reader or antivirus scanner can briefly hold the destination, so
 * the rename retries a few times before surfacing the failure.
 */
export async function writeAtomic(filePath, text) {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, text, 'utf8')
    await renameWithRetry(temporary, filePath)
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch {
      /* best effort */
    }
    throw error
  }
}

async function renameWithRetry(from, to) {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt === 5 || !retryable.has(error?.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

/** Normalize an absolute path for cross-session comparison. */
export function comparablePath(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return process.platform === 'win32' ? text.toLowerCase() : text
}

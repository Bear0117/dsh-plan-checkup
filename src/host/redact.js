/**
 * Mask secret-looking strings before any text leaves the machine.
 *
 * This is a best-effort textual scrub for well-known key formats and obvious
 * `password=` assignments. It cannot find every secret in free text, which is
 * why plan text is only sent to a remote endpoint after `allowEgress: true`.
 * @module dsh-plan-checkup/redact
 */

const MASK = '[REDACTED]'

/** @type {Array<[RegExp, string]>} pattern, replacement (`$1` keeps a prefix) */
const PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, MASK],
  [/\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\bapikey_[A-Za-z0-9_-]{12,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, `$1${MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${MASK}@`],
  [/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)(["']?)[^\s"']{4,}\2/gi, `$1$2${MASK}$2`],
]

/**
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function redact(text) {
  let count = 0
  let output = String(text ?? '')
  for (const [pattern, replacement] of PATTERNS) {
    const matches = output.match(pattern)
    if (matches === null) continue
    count += matches.length
    output = output.replace(pattern, replacement)
  }
  return { text: output, count }
}

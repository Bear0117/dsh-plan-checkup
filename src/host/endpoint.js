/**
 * Where plan text may be sent.
 *
 * A loopback endpoint is always allowed: nothing leaves the machine. Any other
 * endpoint needs `allowEgress: true`, and must be https unless its host is listed
 * in `allowHttpHosts` (for a server on the local network that has no TLS, such
 * as a vLLM box). Both engines use the same rule.
 * @module dsh-plan-checkup/endpoint
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** @param {string} endpoint */
export function isLoopback(endpoint) {
  try {
    const { hostname } = new URL(endpoint)
    return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || /^127\./.test(hostname)
  } catch {
    return false
  }
}

/**
 * Decide whether plan text may be sent to this endpoint.
 * @param {string} endpoint
 * @param {{ allowEgress: boolean, allowHttpHosts?: string[] }} policy
 * @returns {{ ok: true, loopback: boolean } | { ok: false, reason: 'egress-off' | 'insecure-endpoint' | 'bad-endpoint' }}
 */
export function checkEndpoint(endpoint, { allowEgress, allowHttpHosts = [] }) {
  let url
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, reason: 'bad-endpoint' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'bad-endpoint' }
  if (isLoopback(endpoint)) return { ok: true, loopback: true }
  if (url.protocol === 'http:' && !allowHttpHosts.includes(url.hostname.toLowerCase())) return { ok: false, reason: 'insecure-endpoint' }
  if (!allowEgress) return { ok: false, reason: 'egress-off' }
  return { ok: true, loopback: false }
}

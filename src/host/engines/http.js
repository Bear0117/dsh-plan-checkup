/**
 * One JSON POST with a timeout, an outside abort signal, and HTTP failures
 * mapped to engine error kinds. The key, when there is one, travels only in the
 * headers the caller passes and is never part of an error message.
 * @module dsh-plan-checkup/engines/http
 */

import { EngineError } from './error.js'

function retryAfterMs(response) {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function transportError(error, signal, timeoutMs) {
  if (signal?.aborted) return new EngineError('aborted', 'request aborted')
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return new EngineError('timeout', `no answer within ${timeoutMs} ms`)
  return new EngineError('network', `network error: ${error?.cause?.code ?? error?.message ?? String(error)}`)
}

/**
 * @param {{
 *   url: string,
 *   headers?: Record<string, string>,
 *   body: unknown,
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} request
 * @returns {Promise<any>} the parsed response body
 */
export async function postJson({ url, headers = {}, body, timeoutMs, signal, fetchImpl = fetch }) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal !== undefined) signals.push(signal)

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    throw transportError(error, signal, timeoutMs)
  }

  if (!response.ok) {
    const status = response.status
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      // The body is only used in the message.
    }
    if (status === 401 || status === 403) throw new EngineError('auth', `endpoint rejected the key (${status})`, { status })
    if (status === 402) throw new EngineError('quota', 'credit exhausted (402)', { status })
    if (status === 429 || status === 503 || status === 529) throw new EngineError('busy', `endpoint is busy (${status})`, { status, retryAfterMs: retryAfterMs(response) })
    if (status === 400 || status === 404 || status === 422) throw new EngineError('bad-request', `request rejected (${status}): ${detail}`, { status })
    throw new EngineError('server', `endpoint error (${status})`, { status })
  }

  try {
    return await response.json()
  } catch (error) {
    if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw transportError(error, signal, timeoutMs)
    throw new EngineError('invalid', 'response is not JSON')
  }
}

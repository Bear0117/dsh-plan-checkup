/**
 * Errors from a judgment engine, classified so the checkup can decide whether to
 * retry, pause the engine, or fall back to the rules.
 * @module dsh-plan-checkup/engines/error
 */

/** @typedef {'auth' | 'quota' | 'busy' | 'timeout' | 'network' | 'bad-request' | 'server' | 'invalid' | 'aborted'} EngineErrorKind */

export class EngineError extends Error {
  /**
   * @param {EngineErrorKind} kind
   * @param {string} message
   * @param {{ status?: number, retryAfterMs?: number }} [details]
   */
  constructor(kind, message, details = {}) {
    super(message)
    this.name = 'EngineError'
    this.kind = kind
    this.status = details.status
    this.retryAfterMs = details.retryAfterMs
  }
}

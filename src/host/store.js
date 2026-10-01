/**
 * Checkup results and the decision ledger.
 *
 * Results live in memory (bounded) and, when `persist` is on, in
 * `<home>/plan-checkup/results/<session>_<callId>.json`, so a plan reopened
 * after a restart still shows its checkup. A pending checkup can carry a partial
 * result, kept in memory only. The ledger is an append-only JSONL file for later
 * calibration. Nothing here writes to the session log: an unknown session event
 * type would make the session fail to reload.
 * @module dsh-plan-checkup/store
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function safeName(callId) {
  return String(callId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
}

export class CheckupStore {
  /**
   * @param {{ dir: string, memoryEntries: number, persist: boolean, onError?: (message: string) => void }} options
   */
  constructor({ dir, memoryEntries, persist, onError = () => {} }) {
    this.dir = dir
    this.memoryEntries = memoryEntries
    this.persist = persist
    this.onError = onError
    /** @type {Map<string, { status: 'pending' | 'done', sessionId: string | null, result?: object, partial?: object, startedAt: number }>} */
    this.entries = new Map()
  }

  #remember(callId, entry) {
    this.entries.delete(callId)
    this.entries.set(callId, entry)
    while (this.entries.size > this.memoryEntries) this.entries.delete(this.entries.keys().next().value)
  }

  /** @param {string} callId @param {string | null} sessionId */
  begin(callId, sessionId) {
    this.#remember(String(callId), { status: 'pending', sessionId, startedAt: Date.now() })
  }

  /** Attach a partial result to a pending checkup; ignored once it is done. @param {string} callId @param {object} partial */
  progress(callId, partial) {
    const entry = this.entries.get(String(callId))
    if (entry?.status === 'pending') entry.partial = partial
  }

  /** @param {string} callId @param {object} result */
  finish(callId, result) {
    const key = String(callId)
    const previous = this.entries.get(key)
    this.#remember(key, { status: 'done', sessionId: previous?.sessionId ?? result.sessionId ?? null, result, startedAt: previous?.startedAt ?? Date.now() })
    if (!this.persist) return
    try {
      const dir = join(this.dir, 'results')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${safeName(key)}.json`), JSON.stringify(result))
    } catch (error) {
      this.onError(`cannot persist result: ${String(error)}`)
    }
  }

  /**
   * @param {string} callId
   * @returns {{ status: 'pending' | 'done', result?: object, partial?: object } | undefined}
   */
  get(callId) {
    const key = String(callId)
    const entry = this.entries.get(key)
    if (entry !== undefined) return entry
    if (!this.persist) return undefined
    try {
      const result = JSON.parse(readFileSync(join(this.dir, 'results', `${safeName(key)}.json`), 'utf8'))
      const restored = { status: 'done', sessionId: result.sessionId ?? null, result, startedAt: 0 }
      this.#remember(key, restored)
      return restored
    } catch {
      return undefined
    }
  }

  /** @param {string} kind @param {object} data */
  ledger(kind, data) {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, 'ledger.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`)
    } catch (error) {
      this.onError(`cannot write ledger: ${String(error)}`)
    }
  }
}

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { CheckupStore } from '../src/host/store.js'

const dir = mkdtempSync(join(tmpdir(), 'plan-checkup-store-'))
after(() => rmSync(dir, { recursive: true, force: true }))

describe('CheckupStore', () => {
  it('reports pending, then done, and survives a restart', () => {
    const store = new CheckupStore({ dir, memoryEntries: 10, persist: true })
    store.begin('session-a:call_1', 'session-a')
    assert.equal(store.get('session-a:call_1').status, 'pending')
    store.finish('session-a:call_1', { callId: 'call_1', sessionId: 'session-a', counts: { red: 1 } })
    assert.equal(store.get('session-a:call_1').status, 'done')

    const restarted = new CheckupStore({ dir, memoryEntries: 10, persist: true })
    assert.deepEqual(restarted.get('session-a:call_1').result.counts, { red: 1 })
    assert.equal(restarted.get('session-b:call_1'), undefined)
  })

  it('keeps a partial result only while the checkup is pending, and never on disk', () => {
    const store = new CheckupStore({ dir, memoryEntries: 10, persist: true })
    store.begin('session-a:call_2', 'session-a')
    store.progress('session-a:call_2', { pending: true, counts: { red: 1 } })
    assert.deepEqual(store.get('session-a:call_2').partial, { pending: true, counts: { red: 1 } })
    store.finish('session-a:call_2', { callId: 'call_2', sessionId: 'session-a', counts: { red: 2 } })
    store.progress('session-a:call_2', { pending: true, counts: { red: 0 } })
    const done = store.get('session-a:call_2')
    assert.equal(done.status, 'done')
    assert.equal(done.partial, undefined)
    assert.equal(new CheckupStore({ dir, memoryEntries: 10, persist: true }).get('session-a:call_2').partial, undefined)
  })

  it('evicts the oldest entries from memory', () => {
    const store = new CheckupStore({ dir, memoryEntries: 2, persist: false })
    for (const key of ['a', 'b', 'c']) store.finish(key, { callId: key })
    assert.equal(store.get('a'), undefined)
    assert.equal(store.get('c').status, 'done')
  })

  it('appends ledger lines', () => {
    const store = new CheckupStore({ dir, memoryEntries: 2, persist: false })
    store.ledger('decision', { callId: 'x', decision: 'approve' })
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.at(-1).kind, 'decision')
    assert.equal(lines.at(-1).decision, 'approve')
  })
})

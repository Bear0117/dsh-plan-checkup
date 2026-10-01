import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkEndpoint } from '../src/host/endpoint.js'

const off = { allowEgress: false }
const on = { allowEgress: true }

describe('checkEndpoint', () => {
  it('allows loopback without egress consent', () => {
    assert.deepEqual(checkEndpoint('http://127.0.0.1:8791/v1/systemone', off), { ok: true, loopback: true })
    assert.deepEqual(checkEndpoint('http://localhost/v1/systemone', off), { ok: true, loopback: true })
  })

  it('requires https and allowEgress for remote endpoints', () => {
    assert.deepEqual(checkEndpoint('https://api.typesafe.ai/v1/systemone', off), { ok: false, reason: 'egress-off' })
    assert.deepEqual(checkEndpoint('https://api.typesafe.ai/v1/systemone', on), { ok: true, loopback: false })
    assert.deepEqual(checkEndpoint('http://10.0.0.5/v1/systemone', on), { ok: false, reason: 'insecure-endpoint' })
    assert.deepEqual(checkEndpoint('nonsense', on), { ok: false, reason: 'bad-endpoint' })
    assert.deepEqual(checkEndpoint('ftp://127.0.0.1/v1', on), { ok: false, reason: 'bad-endpoint' })
  })

  it('allows plain http only to listed hosts, and still needs allowEgress', () => {
    const lan = 'http://172.16.0.9:7114/v1/chat/completions'
    assert.deepEqual(checkEndpoint(lan, { allowEgress: true, allowHttpHosts: ['172.16.0.9'] }), { ok: true, loopback: false })
    assert.deepEqual(checkEndpoint(lan, { allowEgress: false, allowHttpHosts: ['172.16.0.9'] }), { ok: false, reason: 'egress-off' })
    assert.deepEqual(checkEndpoint(lan, { allowEgress: true, allowHttpHosts: ['172.16.0.10'] }), { ok: false, reason: 'insecure-endpoint' })
    assert.deepEqual(checkEndpoint('http://GPU-Box.lan/v1', { allowEgress: true, allowHttpHosts: ['gpu-box.lan'] }), { ok: true, loopback: false })
  })
})

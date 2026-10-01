import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { EngineError } from '../src/host/engines/error.js'
import { systemOne } from '../src/host/engines/jev.js'

const QUESTIONS = {
  risky: { type: 'noul', instructions: 'Is `step` risky?' },
  scope: { type: 'choice', instructions: 'Scope?', criteria: { required: null, extra: null } },
}

let server
let base
/** @type {(req: import('node:http').IncomingMessage, body: any, res: import('node:http').ServerResponse) => void} */
let behave = () => {}
const seen = []

before(async () => {
  server = createServer((req, res) => {
    const parts = []
    req.on('data', part => parts.push(part))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      seen.push({ headers: req.headers, body })
      behave(req, body, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/v1/systemone`
})
after(() => server.close())

const reply = (res, status, payload, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(payload))
}
const ok = { model: 'jev-1.13.0', answers: { risky: { type: 'noul', noul: 0.91 }, scope: { type: 'choice', choice: 'extra', probabilities: { required: 0.2, extra: 0.8 }, confidence: 0.6 } }, usage: { input_tokens: 321, output_tokens: 20 } }

describe('systemOne', () => {
  it('sends the documented request shape and parses the answers', async () => {
    behave = (req, body, res) => reply(res, 200, ok)
    const response = await systemOne({ endpoint: base, apiKey: 'apikey_test', model: 'jev-1.13.0', state: { step: 'x' }, questions: QUESTIONS, timeoutMs: 2000 })
    const request = seen.at(-1)
    assert.equal(request.headers.authorization, 'Bearer apikey_test')
    assert.deepEqual(Object.keys(request.body).sort(), ['model', 'questions', 'state'])
    assert.equal(response.answers.risky.noul, 0.91)
    assert.equal(response.usage.input_tokens, 321)
    assert.equal(response.model, 'jev-1.13.0')
  })

  it('omits the Authorization header when no key is given', async () => {
    behave = (req, body, res) => reply(res, 200, ok)
    await systemOne({ endpoint: base, model: 'm', state: 's', questions: QUESTIONS, timeoutMs: 2000 })
    assert.equal(seen.at(-1).headers.authorization, undefined)
  })

  it('classifies HTTP failures', async () => {
    const cases = [[401, 'auth'], [402, 'quota'], [429, 'busy'], [503, 'busy'], [529, 'busy'], [404, 'bad-request'], [422, 'bad-request'], [500, 'server']]
    for (const [status, kind] of cases) {
      behave = (req, body, res) => reply(res, status, { detail: 'nope' }, status === 429 ? { 'retry-after': '1' } : {})
      await assert.rejects(
        systemOne({ endpoint: base, model: 'm', state: 's', questions: QUESTIONS, timeoutMs: 2000 }),
        error => error instanceof EngineError && error.kind === kind && (status !== 429 || error.retryAfterMs === 1000),
      )
    }
  })

  it('rejects malformed answers', async () => {
    behave = (req, body, res) => reply(res, 200, { model: 'm', answers: { risky: { type: 'noul', noul: 2 } }, usage: {} })
    await assert.rejects(systemOne({ endpoint: base, model: 'm', state: 's', questions: QUESTIONS, timeoutMs: 2000 }), error => error.kind === 'invalid')
    behave = (req, body, res) => reply(res, 200, { ...ok, answers: { ...ok.answers, scope: { ...ok.answers.scope, choice: 'other' } } })
    await assert.rejects(systemOne({ endpoint: base, model: 'm', state: 's', questions: QUESTIONS, timeoutMs: 2000 }), error => error.kind === 'invalid')
  })

  it('times out', async () => {
    behave = () => {}
    await assert.rejects(systemOne({ endpoint: base, model: 'm', state: 's', questions: QUESTIONS, timeoutMs: 150 }), error => error.kind === 'timeout')
  })

  it('reports an outside abort as aborted', async () => {
    behave = () => {}
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(systemOne({ endpoint: base, model: 'm', state: 's', questions: QUESTIONS, timeoutMs: 2000, signal: controller.signal }), error => error.kind === 'aborted')
  })
})

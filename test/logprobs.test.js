import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { EngineError } from '../src/host/engines/error.js'
import { askOptions, optionsFor, toAnswer } from '../src/host/engines/logprobs.js'
import { stepQuestions } from '../src/host/questions.js'

const QUESTIONS = stepQuestions('en')
const STATE = { task: '拆表', plan_title: '遷移', step: { index: 3, text: '執行 `DROP TABLE users_legacy`' } }

let server
let base
/** @type {(body: any, res: import('node:http').ServerResponse) => void} */
let behave = () => {}
const seen = []

before(async () => {
  server = createServer((req, res) => {
    const parts = []
    req.on('data', part => parts.push(part))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      seen.push({ headers: req.headers, body })
      behave(body, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
})
after(() => server.close())

const reply = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}
/** A chat completion whose single token has these top logprobs, given as [token, probability]. */
const completion = top => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  model: 'qwen-test',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: top[0][0] },
    logprobs: { content: [{ token: top[0][0], logprob: Math.log(top[0][1]), top_logprobs: top.map(([token, p]) => ({ token, logprob: Math.log(p) })) }] },
    finish_reason: 'length',
  }],
  usage: { prompt_tokens: 120, completion_tokens: 1, total_tokens: 121 },
})
const ask = options => askOptions({ endpoint: base, model: 'qwen', state: STATE, timeoutMs: 2000, ...options })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

describe('askOptions', () => {
  it('asks one lettered question and reads the answer from the letter logprobs', async () => {
    behave = (body, res) => reply(res, 200, completion([['A', 0.8], ['B', 0.15], ['The', 0.05]]))
    const reading = await ask({ question: QUESTIONS.irreversible, apiKey: 'k' })
    const { headers, body } = seen.at(-1)
    assert.equal(headers.authorization, 'Bearer k')
    assert.equal(body.model, 'qwen')
    assert.equal(body.max_tokens, 1)
    assert.equal(body.temperature, 0)
    assert.equal(body.logprobs, true)
    assert.equal(body.top_logprobs, 20)
    assert.equal(body.messages.length, 2)
    const prompt = body.messages[1].content
    assert.ok(prompt.startsWith(`State:\n${JSON.stringify(STATE, null, 2)}\n`))
    assert.match(prompt, /\nA\. yes \(For example dropping or emptying database tables/)
    assert.match(prompt, /\nB\. no \(For example creating files/)
    assert.match(prompt, /Reply with one letter: A or B\.$/)
    near(reading.probabilities.true, 0.8 / 0.95)
    near(reading.probabilities.false, 0.15 / 0.95)
    near(reading.optionMass, 0.95)
    assert.deepEqual(reading.usage, { input_tokens: 120, output_tokens: 1 })
    assert.equal(reading.model, 'qwen-test')
  })

  it('merges extraBody without letting it change the readout fields', async () => {
    behave = (body, res) => reply(res, 200, completion([['A', 0.9], ['B', 0.1]]))
    await ask({ question: QUESTIONS.vague, extraBody: { chat_template_kwargs: { enable_thinking: false }, max_tokens: 99, model: 'other', logprobs: false } })
    const { headers, body } = seen.at(-1)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.equal(body.max_tokens, 1)
    assert.equal(body.model, 'qwen')
    assert.equal(body.logprobs, true)
    assert.equal(headers.authorization, undefined)
  })

  it('maps a reversed reading back to the options and accepts any spelling of a letter', async () => {
    behave = (body, res) => reply(res, 200, completion([['b', 0.6], [' A', 0.3], ['B.', 0.1]]))
    const reading = await ask({ question: QUESTIONS.external, reversed: true })
    assert.match(seen.at(-1).body.messages[1].content, /\nA\. no \(Only reads/)
    near(reading.probabilities.true, 0.7)
    near(reading.probabilities.false, 0.3)
    assert.deepEqual(Object.keys(reading.probabilities), ['true', 'false'])
  })

  it('gives each choice option a letter', async () => {
    behave = (body, res) => reply(res, 200, completion([['C', 0.7], ['A', 0.2], ['B', 0.05], ['D', 0.05]]))
    const reading = await ask({ question: QUESTIONS.scope })
    const prompt = seen.at(-1).body.messages[1].content
    assert.match(prompt, /\nA\. required: Needed to deliver/)
    assert.match(prompt, /\nD\. unclear: Cannot tell/)
    assert.match(prompt, /Reply with one letter: A, B, C or D\.$/)
    near(reading.probabilities.extra, 0.7)
    assert.deepEqual(Object.keys(reading.probabilities), ['required', 'supporting', 'extra', 'unclear'])
  })

  it('rejects an answer that is not an option letter', async () => {
    behave = (body, res) => reply(res, 200, completion([['<think>', 0.9], ['A', 0.05]]))
    await assert.rejects(ask({ question: QUESTIONS.vague }), error => error instanceof EngineError && error.kind === 'invalid' && /thinking/.test(error.message))
  })

  it('rejects an endpoint that returns no logprobs', async () => {
    behave = (body, res) => reply(res, 200, { ...completion([['A', 1]]), choices: [{ index: 0, message: { role: 'assistant', content: 'A' }, logprobs: null }] })
    await assert.rejects(ask({ question: QUESTIONS.vague }), error => error.kind === 'invalid' && /logprobs/.test(error.message))
  })

  it('maps HTTP failures to engine error kinds', async () => {
    for (const [status, kind] of [[401, 'auth'], [400, 'bad-request'], [503, 'busy'], [500, 'server']]) {
      behave = (body, res) => reply(res, status, { error: { message: 'nope' } })
      await assert.rejects(ask({ question: QUESTIONS.vague }), error => error.kind === kind)
    }
  })
})

describe('toAnswer', () => {
  it('averages readings into a noul answer', () => {
    assert.deepEqual(toAnswer(QUESTIONS.vague, [{ true: 0.5, false: 0.5 }, { true: 0.7, false: 0.3 }]), { type: 'noul', noul: 0.6 })
  })

  it('picks the most likely choice and reports it as the confidence', () => {
    const answer = toAnswer(QUESTIONS.scope, [{ required: 0.1, supporting: 0.1, extra: 0.75, unclear: 0.05 }])
    assert.equal(answer.type, 'choice')
    assert.equal(answer.choice, 'extra')
    assert.equal(answer.confidence, 0.75)
  })

  it('softens probabilities with a calibration temperature above 1', () => {
    const sharp = toAnswer(QUESTIONS.vague, [{ true: 0.9, false: 0.1 }], 1).noul
    const soft = toAnswer(QUESTIONS.vague, [{ true: 0.9, false: 0.1 }], 2).noul
    near(soft, 0.75)
    assert.ok(soft < sharp && soft > 0.5)
  })

  it('refuses question types the llm engine does not support', () => {
    assert.throws(() => optionsFor({ type: 'score', instructions: 'How bad?' }), error => error.kind === 'bad-request')
  })
})

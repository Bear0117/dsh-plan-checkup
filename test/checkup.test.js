import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EngineGate, runCheckup } from '../src/host/checkup.js'
import { normalizeConfig } from '../src/host/config.js'
import { MIGRATION_PLAN } from './fixtures.js'

const TASK = '把 users 表的個人資料欄位拆到新表 user_profiles，其他功能不變'
const RULES_ONLY_COUNTS = { red: 2, orange: 1, amber: 1, flaggedSteps: 2 }
const EXPECTED_KINDS = [[], [], ['irreversible'], [], ['extra'], ['vague'], ['irreversible', 'external']]

/** How the fakes judge a step: simple keyword rules on the step text alone. */
function judge(id, text) {
  return {
    irreversible: /DROP|force/.test(text) ? 0.94 : 0.03,
    external: /push/.test(text) ? 0.95 : 0.04,
    changes_code: /\.ts|migration/.test(text) ? 0.9 : 0.1,
    vague: /優化整體效能/.test(text) ? 0.86 : 0.1,
    has_verification: 0.1,
    misses_task: 0.2,
  }[id]
}
const scopeOf = text => (/README|徽章/.test(text) ? 'extra' : 'required')

/** A fetch stand-in that answers like Jev. */
function fakeJev({ failFirst = null, status = 200, delayMs = 0 } = {}) {
  const calls = []
  let failed = false
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    if (delayMs > 0) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
    if (failFirst !== null && !failed) {
      failed = true
      return new Response('{}', { status: failFirst, headers: { 'retry-after': '0' } })
    }
    if (status !== 200) return new Response('{}', { status })
    // Judge the step itself, the way the questions point at `step.text`.
    const text = body.state.step?.text ?? JSON.stringify(body.state.plan)
    const answers = {}
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === 'choice') {
        const extra = scopeOf(text) === 'extra'
        answers[id] = { type: 'choice', choice: extra ? 'extra' : 'required', probabilities: { required: extra ? 0.1 : 0.9, supporting: 0, extra: extra ? 0.9 : 0.1, unclear: 0 }, confidence: 0.85 }
      } else {
        answers[id] = { type: 'noul', noul: judge(id, text) }
      }
    }
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { impl, calls }
}

// Which question a lettered prompt asks, from its (English) instructions.
const QUESTION_IDS = [
  [/delete or overwrite/, 'irreversible'],
  [/outside the local workspace/, 'external'],
  [/modify source code/, 'changes_code'],
  [/too vague/, 'vague'],
  [/checks the changes work/, 'has_verification'],
  [/leave out part/, 'misses_task'],
]

/** A fetch stand-in for an OpenAI-compatible endpoint that returns letter logprobs. */
function fakeLlm({ fail = null } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    if (fail === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (fail === 'no-logprobs') {
      return new Response(JSON.stringify({ model: 'qwen-test', choices: [{ index: 0, message: { role: 'assistant', content: 'A' }, logprobs: null }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const prompt = body.messages[1].content
    const state = JSON.parse(prompt.slice('State:\n'.length, prompt.indexOf('\n\nQuestion: ')))
    const question = prompt.slice(prompt.indexOf('\n\nQuestion: '), prompt.indexOf('\nOptions:'))
    const text = state.step?.text ?? JSON.stringify(state.plan)
    const options = [...prompt.matchAll(/^([A-T])\. ([a-z_]+)/gm)].map(match => ({ letter: match[1], key: match[2] }))
    let probability
    if (options[0].key === 'yes' || options[0].key === 'no') {
      const p = judge(QUESTION_IDS.find(([pattern]) => pattern.test(question))[1], text)
      probability = { yes: p, no: 1 - p }
    } else {
      const extra = scopeOf(text) === 'extra'
      probability = { required: extra ? 0.05 : 0.85, supporting: 0.05, extra: extra ? 0.85 : 0.05, unclear: 0.05 }
    }
    const top = options.map(option => ({ token: option.letter, logprob: Math.log(probability[option.key]) }))
    return new Response(JSON.stringify({
      model: 'qwen-test',
      choices: [{ index: 0, message: { role: 'assistant', content: top[0].token }, logprobs: { content: [{ ...top[0], top_logprobs: top }] }, finish_reason: 'length' }],
      usage: { prompt_tokens: 250, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { impl, calls }
}

const configWith = overrides => normalizeConfig(overrides).config
const run = (config, fetchImpl, gate = new EngineGate(), resolveKey = async () => 'apikey_test', onProgress = undefined) =>
  runCheckup({ plan: MIGRATION_PLAN, task: TASK, callId: 'call_1', sessionId: 'session-1', config, resolveKey, gate, fetchImpl, onProgress })
const llmConfig = (llm = {}, rest = {}) => configWith({ engine: 'llm', llm: { endpoint: 'http://127.0.0.1:8000/v1/chat/completions', model: 'qwen-test', ...llm }, ...rest })

describe('runCheckup with Jev', () => {
  it('stays on rules when egress is off, and sends nothing', async () => {
    const jev = fakeJev()
    const result = await run(configWith({}), jev.impl)
    assert.equal(jev.calls.length, 0)
    assert.equal(result.engine.state, 'off')
    assert.equal(result.engine.reason, 'egress-off')
    assert.deepEqual(result.counts, RULES_ONLY_COUNTS)
  })

  it('reports a missing key for a remote endpoint', async () => {
    const jev = fakeJev()
    const result = await run(configWith({ jev: { allowEgress: true } }), jev.impl, new EngineGate(), async () => undefined)
    assert.equal(jev.calls.length, 0)
    assert.equal(result.engine.reason, 'no-key')
  })

  it('asks one request per step plus one for the plan, and combines the answers', async () => {
    const jev = fakeJev()
    const result = await run(configWith({ jev: { allowEgress: true } }), jev.impl)
    assert.equal(jev.calls.length, 8)
    assert.equal(result.engine.kind, 'jev')
    assert.equal(result.engine.state, 'on')
    assert.equal(result.engine.requests, 8)
    assert.equal(result.engine.inputTokens, 4000)
    assert.equal(result.engine.answeredModel, 'jev-1.13.0')
    const stepCall = jev.calls.find(call => call.body.state.step?.index === 3)
    assert.equal(stepCall.body.state.task, TASK)
    assert.deepEqual(Object.keys(stepCall.body.questions), ['scope', 'irreversible', 'external', 'changes_code', 'vague'])
    assert.deepEqual(stepCall.body.state.neighbors, ['新增 migration，建立 `user_profiles` 表', '修改 `src/models/user.ts` 與相關查詢'])
    assert.deepEqual(result.steps.map(step => step.flags.map(flag => flag.kind)), EXPECTED_KINDS)
    assert.deepEqual(result.steps[2].flags[0].sources, ['rule', 'jev'])
    assert.deepEqual(result.plan.flags.map(flag => flag.kind), ['no-verification'])
  })

  it('redacts secrets in the task before sending', async () => {
    const jev = fakeJev()
    await runCheckup({
      plan: MIGRATION_PLAN,
      task: `${TASK}，金鑰是 sk-proj-abcdefghijklmnopqrstuvwx`,
      callId: 'call_2',
      sessionId: null,
      config: configWith({ jev: { allowEgress: true } }),
      resolveKey: async () => 'k',
      gate: new EngineGate(),
      fetchImpl: jev.impl,
    })
    assert.ok(jev.calls.every(call => !JSON.stringify(call.body).includes('sk-proj-abcdefgh')))
  })

  it('retries a busy answer once and pauses the engine after an auth failure', async () => {
    const busy = fakeJev({ failFirst: 429 })
    const retried = await run(configWith({ jev: { allowEgress: true, concurrency: 1 } }), busy.impl)
    assert.equal(retried.engine.state, 'on')
    assert.equal(busy.calls.length, 9)

    const gate = new EngineGate()
    const denied = fakeJev({ status: 401 })
    const first = await run(configWith({ jev: { allowEgress: true, concurrency: 1 } }), denied.impl, gate)
    assert.equal(first.engine.state, 'error')
    assert.equal(first.engine.reason, 'auth')
    assert.equal(denied.calls.length, 1)
    const second = await run(configWith({ jev: { allowEgress: true } }), denied.impl, gate)
    assert.equal(second.engine.reason, 'paused-auth')
    assert.equal(denied.calls.length, 1)
    assert.deepEqual(second.counts, first.counts)
  })

  it('keeps the rule results when the overall budget runs out', async () => {
    const slow = fakeJev({ delayMs: 400 })
    const result = await run(configWith({ jev: { allowEgress: true, timeoutMs: 200, totalTimeoutMs: 250 } }), slow.impl)
    assert.equal(result.engine.state, 'error')
    assert.equal(result.engine.reason, 'timeout')
    assert.deepEqual(result.counts, RULES_ONLY_COUNTS)
    assert.ok(result.engine.latencyMs < 1000)
  })

  it('reports rule results first, then each finished step, and holds plan flags until the end', async () => {
    const snapshots = []
    const result = await run(configWith({ jev: { allowEgress: true, concurrency: 2 } }), fakeJev().impl, new EngineGate(), async () => 'k', partial => snapshots.push(partial))
    assert.equal(snapshots.length, 9)
    const [first, last] = [snapshots[0], snapshots.at(-1)]
    assert.equal(first.pending, true)
    assert.equal(first.engine.state, 'running')
    assert.deepEqual(first.engine.progress, { done: 0, total: 8 })
    assert.equal(first.steps.filter(step => step.pending).length, 7)
    assert.deepEqual(first.counts, { red: 2, orange: 1, amber: 0, flaggedSteps: 2 })
    assert.ok(snapshots.every(partial => partial.plan.pending && partial.plan.flags.length === 0))
    assert.deepEqual(snapshots.map(partial => partial.engine.progress.done), [0, 1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(last.steps.filter(step => step.pending).length, 0)
    assert.equal(result.pending, undefined)
    assert.deepEqual(result.plan.flags.map(flag => flag.kind), ['no-verification'])
  })
})

describe('runCheckup with an llm endpoint', () => {
  it('asks one question per call and reaches the same flags as Jev', async () => {
    const llm = fakeLlm()
    const result = await run(llmConfig(), llm.impl)
    assert.equal(llm.calls.length, 7 * 5 + 2)
    assert.equal(result.engine.kind, 'llm')
    assert.equal(result.engine.label, 'qwen-test')
    assert.equal(result.engine.state, 'on')
    assert.equal(result.engine.requests, 37)
    assert.equal(result.engine.inputTokens, 37 * 250)
    assert.equal(result.engine.costUsd, 0)
    assert.deepEqual(result.steps.map(step => step.flags.map(flag => flag.kind)), EXPECTED_KINDS)
    assert.deepEqual(result.steps[2].flags[0].sources, ['rule', 'llm'])
    assert.equal(result.steps[2].flags[0].p, 0.94)
    assert.deepEqual(result.plan.flags.map(flag => flag.kind), ['no-verification'])
    assert.ok(llm.calls.every(call => call.body.max_tokens === 1 && call.body.logprobs === true))
  })

  it('asks each question in both orders with swapOptions', async () => {
    const llm = fakeLlm()
    const result = await run(llmConfig({ swapOptions: true }), llm.impl)
    assert.equal(llm.calls.length, 74)
    assert.equal(result.engine.swapOptions, true)
    assert.deepEqual(result.steps.map(step => step.flags.map(flag => flag.kind)), EXPECTED_KINDS)
    const firstLetters = llm.calls.filter(call => /Question: Would carrying out `step.text` delete/.test(call.body.messages[1].content))
      .map(call => call.body.messages[1].content.match(/\nA\. (yes|no)/)[1])
    assert.deepEqual([...new Set(firstLetters)].sort(), ['no', 'yes'])
  })

  it('stays off without a model, and sends plain http only to listed hosts', async () => {
    const llm = fakeLlm()
    const noModel = await run(llmConfig({ model: '' }), llm.impl)
    assert.equal(noModel.engine.reason, 'no-model')
    const lan = { endpoint: 'http://10.1.2.3:8000/v1/chat/completions', allowEgress: true }
    const unlisted = await run(llmConfig(lan), llm.impl)
    assert.equal(unlisted.engine.reason, 'insecure-endpoint')
    assert.equal(llm.calls.length, 0)
    const listed = await run(llmConfig({ ...lan, allowHttpHosts: ['10.1.2.3'] }), llm.impl)
    assert.equal(listed.engine.state, 'on')
    assert.equal(llm.calls.length, 37)
  })

  it('needs a key only when apiKeyEnv names one', async () => {
    const llm = fakeLlm()
    const asked = []
    const missing = await run(llmConfig({ apiKeyEnv: 'LLM_KEY' }), llm.impl, new EngineGate(), async name => { asked.push(name) })
    assert.equal(missing.engine.reason, 'no-key')
    assert.deepEqual(asked, ['LLM_KEY'])
    await run(llmConfig({ apiKeyEnv: 'LLM_KEY' }), llm.impl, new EngineGate(), async () => 'local-key')
    assert.ok(llm.calls.every(call => call.headers.authorization === 'Bearer local-key'))
    const before = llm.calls.length
    await run(llmConfig(), llm.impl, new EngineGate(), async () => 'unused')
    assert.ok(llm.calls.slice(before).every(call => call.headers.authorization === undefined))
  })

  it('stops after a network failure when nothing has answered, and keeps the rules', async () => {
    const llm = fakeLlm({ fail: 'network' })
    const result = await run(llmConfig(), llm.impl)
    assert.equal(llm.calls.length, 8)
    assert.equal(result.engine.state, 'error')
    assert.equal(result.engine.reason, 'network')
    assert.equal(result.engine.failed, 37)
    assert.deepEqual(result.counts, RULES_ONLY_COUNTS)
  })

  it('stops a misconfigured endpoint after a wave of unreadable answers', async () => {
    const llm = fakeLlm({ fail: 'no-logprobs' })
    const result = await run(llmConfig(), llm.impl)
    assert.ok(llm.calls.length >= 8 && llm.calls.length < 16, `${llm.calls.length} calls`)
    assert.equal(result.engine.state, 'error')
    assert.equal(result.engine.reason, 'invalid')
    assert.match(result.engine.errors[0].message, /logprobs/)
    assert.deepEqual(result.counts, RULES_ONLY_COUNTS)
  })
})

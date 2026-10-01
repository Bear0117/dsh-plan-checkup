import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULTS, normalizeConfig } from '../src/host/config.js'
import { redact } from '../src/host/redact.js'

describe('redact', () => {
  it('masks well-known key formats and credential assignments', () => {
    const input = [
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'aws AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abcdefghijklmnop1234',
      'db postgres://admin:hunter22@db.internal:5432/app',
      'password = "correct-horse"',
    ].join('\n')
    const { text, count } = redact(input)
    assert.doesNotMatch(text, /sk-proj-abc|ghp_abc|AKIAABC|abcdefghijklmnop1234|hunter22|correct-horse/)
    assert.match(text, /Bearer \[REDACTED\]/)
    assert.match(text, /postgres:\/\/\[REDACTED\]@db\.internal/)
    assert.ok(count >= 6)
  })

  it('leaves ordinary plan text alone', () => {
    const plain = '修改 `src/models/user.ts`，執行 `pnpm test`'
    assert.deepEqual(redact(plain), { text: plain, count: 0 })
  })
})

describe('normalizeConfig', () => {
  it('fills every default from an empty config', () => {
    const { config, warnings } = normalizeConfig(undefined)
    assert.deepEqual(warnings, [])
    assert.equal(config.jev.allowEgress, false)
    assert.equal(config.jev.model, DEFAULTS.jev.model)
    assert.equal(config.thresholds.irreversible, 0.6)
  })

  it('defaults to the Jev engine with the llm engine unconfigured', () => {
    const { config } = normalizeConfig({})
    assert.equal(config.engine, 'jev')
    assert.deepEqual(config.jev.allowHttpHosts, [])
    assert.equal(config.llm.model, '')
    assert.equal(config.llm.allowEgress, false)
    assert.equal(config.llm.swapOptions, false)
    assert.equal(config.llm.temperature, 1)
    assert.deepEqual(config.llm.extraBody, {})
  })

  it('validates the llm block', () => {
    const { config, warnings } = normalizeConfig({
      engine: 'llm',
      llm: {
        endpoint: 'http://172.16.0.9:7114/v1/chat/completions',
        model: ' Qwen3.8-27B ',
        allowEgress: true,
        allowHttpHosts: ['172.16.0.9', 'GPU-Box.lan'],
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
        topLogprobs: 50,
        temperature: 0,
        apiKeyEnv: 'bad name',
      },
    })
    assert.equal(config.engine, 'llm')
    assert.equal(config.llm.model, 'Qwen3.8-27B')
    assert.deepEqual(config.llm.allowHttpHosts, ['172.16.0.9', 'gpu-box.lan'])
    assert.deepEqual(config.llm.extraBody, { chat_template_kwargs: { enable_thinking: false } })
    assert.equal(config.llm.topLogprobs, 20)
    assert.equal(config.llm.temperature, 1)
    assert.equal(config.llm.apiKeyEnv, '')
    assert.equal(warnings.length, 3)
  })

  it('rejects hosts written with a port or scheme, and warns when the llm engine has no model', () => {
    const { config, warnings } = normalizeConfig({ engine: 'llm', llm: { allowHttpHosts: ['172.16.0.9:7114'] }, jev: { allowHttpHosts: ['http://box'] } })
    assert.deepEqual(config.llm.allowHttpHosts, [])
    assert.deepEqual(config.jev.allowHttpHosts, [])
    assert.equal(warnings.length, 3)
    assert.match(warnings.at(-1), /llm\.model is empty/)
  })

  it('keeps valid overrides and replaces invalid ones with a warning', () => {
    const { config, warnings } = normalizeConfig({
      lang: 'zh-TW',
      jev: { allowEgress: true, timeoutMs: 'fast', endpoint: 'not a url' },
      thresholds: { vague: 1.5, extra: 0.5 },
    })
    assert.equal(config.lang, 'zh-TW')
    assert.equal(config.jev.allowEgress, true)
    assert.equal(config.jev.timeoutMs, DEFAULTS.jev.timeoutMs)
    assert.equal(config.jev.endpoint, DEFAULTS.jev.endpoint)
    assert.equal(config.thresholds.vague, DEFAULTS.thresholds.vague)
    assert.equal(config.thresholds.extra, 0.5)
    assert.equal(warnings.length, 3)
  })
})

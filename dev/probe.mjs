// Run one plan through a judgment engine outside dsh and print what it saw: a
// quick way to check that an endpoint returns usable logprobs, and how long a
// checkup takes, before pointing dsh at it.
// Usage:
//   node dev/probe.mjs --endpoint http://127.0.0.1:8000/v1/chat/completions --model NAME
//   options: --engine llm|jev  --allow-egress  --allow-http-host HOST  --api-key-env NAME
//            --extra JSON  --swap  --temperature T  --prompt-lang en|zh  --concurrency N
//            --plan FILE  --task TEXT  --json
// The plan goes only to --endpoint, under the plugin's own rules: a non-loopback
// endpoint needs --allow-egress, and plain http also needs --allow-http-host.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { EngineGate, runCheckup } from '../src/host/checkup.js'
import { normalizeConfig } from '../src/host/config.js'
import { MIGRATION_PLAN } from '../test/fixtures.js'

const DEFAULT_TASK = '幫我把 users 表的個人資料欄位拆到新的 user_profiles 表，舊資料要保留，完成後要能通過現有測試。'

const { values } = parseArgs({
  options: {
    engine: { type: 'string', default: 'llm' },
    endpoint: { type: 'string' },
    model: { type: 'string' },
    'allow-egress': { type: 'boolean', default: false },
    'allow-http-host': { type: 'string', multiple: true, default: [] },
    'api-key-env': { type: 'string' },
    extra: { type: 'string' },
    swap: { type: 'boolean', default: false },
    temperature: { type: 'string' },
    'prompt-lang': { type: 'string', default: 'en' },
    concurrency: { type: 'string' },
    plan: { type: 'string' },
    task: { type: 'string', default: DEFAULT_TASK },
    json: { type: 'boolean', default: false },
  },
})

const block = {
  allowEgress: values['allow-egress'],
  allowHttpHosts: values['allow-http-host'],
  ...(values.endpoint ? { endpoint: values.endpoint } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values['api-key-env'] ? { apiKeyEnv: values['api-key-env'] } : {}),
  ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
}
if (values.engine === 'llm') {
  if (values.extra) block.extraBody = JSON.parse(values.extra)
  block.swapOptions = values.swap
  if (values.temperature) block.temperature = Number(values.temperature)
}
const { config, warnings } = normalizeConfig({ engine: values.engine, promptLang: values['prompt-lang'], [values.engine]: block })
for (const warning of warnings) console.error(`config: ${warning}`)

const started = performance.now()
let firstStepMs = null
const result = await runCheckup({
  plan: values.plan ? readFileSync(values.plan, 'utf8') : MIGRATION_PLAN,
  task: values.task,
  callId: 'probe',
  sessionId: null,
  config,
  resolveKey: async name => process.env[name] || undefined,
  gate: new EngineGate(),
  onProgress: partial => {
    if (firstStepMs === null && partial.engine.progress.done > 0) firstStepMs = Math.round(performance.now() - started)
  },
})

if (values.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const { engine } = result
  console.log(`${engine.kind} ${engine.state}${engine.reason ? ` (${engine.reason})` : ''} · ${engine.answeredModel ?? engine.model} · ${engine.completed}/${engine.requests} calls · ${engine.latencyMs} ms (first step at ${firstStepMs ?? '-'} ms) · ${engine.inputTokens} input tokens`)
  for (const error of engine.errors) console.log(`  error: ${error.kind} at ${error.request}: ${error.message}`)
  const p = value => (typeof value === 'number' ? value.toFixed(2) : '  - ')
  console.log('step  scope            irrev  ext    code   vague  flags')
  for (const step of result.steps) {
    const signals = step.signals
    const scope = signals ? `${signals.scope} ${p(signals.scopeConfidence)}` : '-'
    const flags = step.flags.map(flag => `${flag.kind}[${flag.sources.join('+')}]`).join(' ')
    console.log(`${String(step.index).padEnd(5)} ${scope.padEnd(16)} ${p(signals?.irreversible)}   ${p(signals?.external)}   ${p(signals?.changesCode)}   ${p(signals?.vague)}   ${flags || '-'}  ${step.firstLine.slice(0, 40)}`)
  }
  const plan = result.plan
  console.log(`plan  has_verification ${p(plan.signals?.hasVerification)} · misses_task ${p(plan.signals?.missesTask)} · flags: ${plan.flags.map(flag => flag.kind).join(' ') || 'none'}`)
}

// Run one engine configuration over the evaluation set through the plugin's own
// runCheckup, so the requests are exactly what the product sends. Writes one
// JSONL line per plan: signals, flags, latency and errors. Labels stay in the
// dataset; report.mjs joins them. An existing output file is resumed.
// Usage: node eval/run.mjs <config> [--plans eval/data/plans.jsonl] [--limit N] [--run name]
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { EngineGate, runCheckup } from '../src/host/checkup.js'
import { normalizeConfig } from '../src/host/config.js'
import { CONFIGS } from './configs.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plans: { type: 'string', default: 'eval/data/plans.jsonl' },
    limit: { type: 'string' },
    run: { type: 'string' },
  },
})

const configName = positionals[0]
if (!CONFIGS[configName]) throw new Error(`unknown config "${configName}"; one of ${Object.keys(CONFIGS).join(', ')}`)
const { config, warnings } = normalizeConfig(CONFIGS[configName]())
if (warnings.length > 0) throw new Error(`config warnings: ${warnings.join('; ')}`)

const runName = values.run ?? configName
const out = `eval/runs/${runName}.jsonl`
mkdirSync('eval/runs', { recursive: true })
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).id) : [])

let plans = readFileSync(values.plans, 'utf8').trim().split('\n').map(line => JSON.parse(line))
if (values.limit) plans = plans.slice(0, Number(values.limit))
const todo = plans.filter(plan => !done.has(plan.id))
console.log(`${runName}: ${todo.length} of ${plans.length} plans to run (${done.size} already in ${out})`)

const gate = new EngineGate()
const started = Date.now()
for (const [i, plan] of todo.entries()) {
  const result = await runCheckup({
    plan: plan.markdown,
    task: plan.task,
    callId: plan.id,
    sessionId: 'eval',
    config,
    resolveKey: async () => undefined,
    gate,
  })
  const { engine } = result
  appendFileSync(out, `${JSON.stringify({
    id: plan.id,
    config: configName,
    parsedSteps: result.totalSteps,
    engine: {
      kind: engine.kind,
      state: engine.state,
      reason: engine.reason,
      answeredModel: engine.answeredModel,
      requests: engine.requests,
      completed: engine.completed,
      failed: engine.failed,
      inputTokens: engine.inputTokens,
      latencyMs: engine.latencyMs,
      errors: engine.errors,
    },
    steps: result.steps.map(step => ({
      index: step.index,
      answered: step.answered,
      signals: step.signals,
      flags: step.flags.map(flag => ({ kind: flag.kind, sources: flag.sources })),
    })),
    plan: { signals: result.plan.signals, flags: result.plan.flags.map(flag => flag.kind) },
  })}\n`)
  if ((i + 1) % 10 === 0 || i === todo.length - 1) {
    const elapsed = (Date.now() - started) / 1000
    console.log(`${runName}: ${i + 1}/${todo.length} plans, ${elapsed.toFixed(0)} s, last ${engine.state} ${engine.completed}/${engine.requests} calls ${engine.latencyMs} ms`)
  }
}

// Build the synthetic evaluation set from scenarios.js: one JSONL line per plan
// with the markdown an agent would hand in, the task, and the labels of every
// step (see LABELS.md). Seeded, so the same command always writes the same file.
// `--split test` builds the held-out set from the test scenarios and pools.
// `--only` and `--except` take comma-separated scenario ids, so a training set
// and a validation set can be split by scenario.
// Usage: node eval/generate.mjs [--split dev|test] [--only a,b | --except a,b] [--count N] [--seed N] [--out path]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { DEFAULTS } from '../src/host/config.js'
import { parsePlan } from '../src/host/parse.js'
import { GENERIC, GENERIC_TEST, SCENARIOS, TEST_SCENARIOS, issueType } from './scenarios.js'

const { values: args } = parseArgs({
  options: {
    split: { type: 'string', default: 'dev' },
    only: { type: 'string' },
    except: { type: 'string' },
    count: { type: 'string' },
    seed: { type: 'string' },
    out: { type: 'string' },
  },
})
const test = args.split === 'test'
const ids = value => new Set(value.split(',').map(id => id.trim()).filter(Boolean))
let scenarios = test ? TEST_SCENARIOS : SCENARIOS
if (args.only) scenarios = scenarios.filter(scenario => ids(args.only).has(scenario.id))
if (args.except) scenarios = scenarios.filter(scenario => !ids(args.except).has(scenario.id))
if (scenarios.length === 0) throw new Error('no scenarios left after --only/--except')
const pools = test ? GENERIC_TEST : GENERIC
const values = {
  count: args.count ?? String(scenarios.length * 15),
  seed: args.seed ?? (test ? '20261001' : '20260930'),
  out: args.out ?? (test ? 'eval/data/test.jsonl' : 'eval/data/plans.jsonl'),
}

const LANGS = ['zh-TW', 'zh-CN', 'en']
const ISSUE_TYPES = ['irreversible', 'external', 'extra', 'vague']

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(Number(values.seed))
const pick = list => list[Math.floor(rng() * list.length)]
const weighted = pairs => {
  let r = rng()
  for (const [value, weight] of pairs) {
    if ((r -= weight) < 0) return value
  }
  return pairs.at(-1)[0]
}

function buildPlan(n) {
  const scenario = scenarios[n % scenarios.length]
  // Languages rotate per round, so every scenario appears in each language equally often.
  const lang = LANGS[Math.floor(n / scenarios.length) % LANGS.length]
  const read = rng() < 0.8 ? [{ entry: pick(scenario.read), source: 'read' }] : []

  let parts = scenario.parts.map((options, part) => ({ entry: pick(options), source: 'part', part }))
  let dropped = null
  if (parts.length >= 2 && rng() < 0.25) {
    dropped = Math.floor(rng() * parts.length)
    parts = parts.filter(item => item.part !== dropped)
  }

  // Issues go anywhere among the task steps, one per type at most.
  const body = [...parts]
  const used = new Set(body.map(item => item.entry))
  const types = []
  const count = weighted([[0, 0.3], [1, 0.45], [2, 0.25]])
  for (let i = 0; i < count; i += 1) {
    const type = pick(ISSUE_TYPES.filter(candidate => !types.includes(candidate)))
    const own = scenario.issues.filter(entry => issueType(entry) === type && !used.has(entry))
    const generic = pools[type].filter(entry => !used.has(entry))
    const pool = own.length > 0 && (generic.length === 0 || rng() < 0.65) ? own : generic
    if (pool.length === 0) continue
    const entry = pick(pool)
    used.add(entry)
    types.push(type)
    body.splice(Math.floor(rng() * (body.length + 1)), 0, { entry, source: 'issue', type })
  }

  // Verification usually comes last, sometimes just before a trailing push or deploy.
  const hasVerification = rng() < 0.6
  if (hasVerification) {
    const entry = rng() < 0.7 ? pick(scenario.verify) : pick(pools.verify)
    const last = body.at(-1)
    const beforeLast = last?.source === 'issue' && last.entry.labels.external === 1 && rng() < 0.7
    body.splice(beforeLast ? body.length - 1 : body.length, 0, { entry, source: 'verify' })
  }

  const entries = [...read, ...body]
  const bullets = rng() < 0.1
  const lines = [`# ${scenario.title[lang]}`, '']
  if (scenario.intro && rng() < 0.6) lines.push(scenario.intro[lang], '')
  entries.forEach((item, i) => lines.push(`${bullets ? '-' : `${i + 1}.`} ${item.entry.text[lang]}`))
  const markdown = lines.join('\n')

  const parsed = parsePlan(markdown, DEFAULTS.limits)
  if (parsed.totalSteps !== entries.length) throw new Error(`plan ${n}: parsed ${parsed.totalSteps} steps, built ${entries.length}`)

  const steps = entries.map((item, i) => ({
    index: i + 1,
    source: item.source,
    issueType: item.type ?? null,
    tags: item.entry.tags,
    labels: item.entry.labels,
  }))
  const changesCode = steps.map(item => item.labels.changes_code)
  const noVerification = hasVerification ? 0 : changesCode.includes(1) ? 1 : changesCode.includes(null) ? null : 0
  return {
    id: `p${String(n + 1).padStart(3, '0')}-${scenario.id}-${lang}`,
    scenario: scenario.id,
    lang,
    task: scenario.task[lang],
    markdown,
    steps,
    labels: { has_verification: hasVerification ? 1 : 0, misses_task: dropped === null ? 0 : 1, no_verification: noVerification },
    meta: { droppedPart: dropped, issues: types, bullets },
  }
}

const plans = Array.from({ length: Number(values.count) }, (_, n) => buildPlan(n))
mkdirSync(dirname(values.out), { recursive: true })
writeFileSync(values.out, `${plans.map(plan => JSON.stringify(plan)).join('\n')}\n`)

// What the set holds, so a skewed draw shows up before any engine runs.
const steps = plans.flatMap(plan => plan.steps)
const positives = key => steps.filter(item => item.labels[key] === 1).length
const unknown = key => steps.filter(item => item.labels[key] === null).length
console.log(`${plans.length} plans, ${steps.length} steps -> ${values.out}`)
console.log(`languages: ${LANGS.map(lang => `${lang} ${plans.filter(plan => plan.lang === lang).length}`).join(', ')}`)
for (const key of ['irreversible', 'external', 'changes_code', 'vague']) console.log(`${key.padEnd(13)} positive ${positives(key)}, unscored ${unknown(key)}`)
console.log(`scope         required ${steps.filter(item => item.labels.scope === 'required').length}, supporting ${steps.filter(item => item.labels.scope === 'supporting').length}, extra ${steps.filter(item => item.labels.scope === 'extra').length}, unscored ${steps.filter(item => item.labels.scope === null).length}`)
console.log(`plans         has_verification ${plans.filter(plan => plan.labels.has_verification === 1).length}, misses_task ${plans.filter(plan => plan.labels.misses_task === 1).length}, no_verification ${plans.filter(plan => plan.labels.no_verification === 1).length}`)
console.log(`tags          ${['verify-trap', 'tracked-delete', 'required-risky', 'context-extra'].map(tag => `${tag} ${steps.filter(item => item.tags.includes(tag)).length}`).join(', ')}`)

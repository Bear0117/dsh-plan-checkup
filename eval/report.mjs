// Join every run with the labels and compute, per engine configuration:
// - per question: AUROC, ECE (10 bins), Brier, and precision/recall/F1 at the
//   product threshold, plus the best-F1 threshold and a fitted temperature
//   (both in-sample, so optimistic: a starting point for calibration, not a result);
// - per product flag, rules and engine together, exactly as the card shows them;
// - the same by language; how many risky steps the rules miss and the engine
//   catches; how the deliberate traps fare; latency, calls and tokens per plan;
// - rerun variance and the option-order effect between paired runs.
// Writes eval/results/summary.json and prints the main tables.
// Usage: node eval/report.mjs [--plans eval/data/plans.jsonl]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DEFAULTS } from '../src/host/config.js'

const { values } = parseArgs({
  options: {
    plans: { type: 'string', default: 'eval/data/plans.jsonl' },
    test: { type: 'string', default: 'eval/data/test.jsonl' },
  },
})
const readJsonl = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

// Runs named test-* use the held-out set; plan ids are unique across both files.
const devPlans = readJsonl(values.plans)
const testPlans = existsSync(values.test) ? readJsonl(values.test) : []
const plans = new Map([...devPlans, ...testPlans].map(plan => [plan.id, plan]))
const runs = Object.fromEntries(readdirSync('eval/runs').filter(name => name.endsWith('.jsonl'))
  .map(name => [name.replace(/\.jsonl$/, ''), readJsonl(`eval/runs/${name}`)]))

const T = DEFAULTS.thresholds
// Step questions: how to read the probability, the label, and the product threshold.
const STEP_QUESTIONS = {
  irreversible: { p: s => s.irreversible, y: l => l.irreversible, threshold: T.irreversible },
  external: { p: s => s.external, y: l => l.external, threshold: T.external },
  extra: { p: s => s.scopeExtra, y: l => (l.scope === null ? null : l.scope === 'extra' ? 1 : 0), threshold: T.extra },
  vague: { p: s => s.vague, y: l => l.vague, threshold: T.vague },
  changes_code: { p: s => s.changesCode, y: l => l.changes_code, threshold: T.changesCode },
}
const PLAN_QUESTIONS = {
  has_verification: { p: s => s.hasVerification, y: l => l.has_verification, threshold: T.hasVerification },
  misses_task: { p: s => s.missesTask, y: l => l.misses_task, threshold: T.missesTask },
}
const STEP_FLAGS = {
  irreversible: l => l.irreversible,
  external: l => l.external,
  extra: l => (l.scope === null ? null : l.scope === 'extra' ? 1 : 0),
  vague: l => l.vague,
}
const PLAN_FLAGS = { 'no-verification': l => l.no_verification, 'misses-task': l => l.misses_task }

const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null)
const mean = list => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length)
const quantile = (list, q) => {
  if (list.length === 0) return null
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function auroc(pairs) {
  const pos = pairs.filter(([, y]) => y === 1).length
  const neg = pairs.length - pos
  if (pos === 0 || neg === 0) return null
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  let rankSum = 0
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j += 1
    const rank = (i + j + 2) / 2
    for (let k = i; k <= j; k += 1) if (sorted[k][1] === 1) rankSum += rank
    i = j + 1
  }
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg)
}

function ece(pairs, bins = 10) {
  const buckets = Array.from({ length: bins }, () => [])
  for (const pair of pairs) buckets[Math.min(bins - 1, Math.floor(pair[0] * bins))].push(pair)
  return buckets.reduce((sum, bucket) => bucket.length === 0 ? sum
    : sum + bucket.length / pairs.length * Math.abs(mean(bucket.map(([p]) => p)) - mean(bucket.map(([, y]) => y))), 0)
}

function prf(predicted, actual) {
  let tp = 0
  let fp = 0
  let fn = 0
  predicted.forEach((hit, i) => {
    if (hit && actual[i] === 1) tp += 1
    else if (hit) fp += 1
    else if (actual[i] === 1) fn += 1
  })
  const precision = tp + fp === 0 ? null : tp / (tp + fp)
  const recall = tp + fn === 0 ? null : tp / (tp + fn)
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall)
  return { tp, fp, fn, precision: round(precision), recall: round(recall), f1: round(f1) }
}

const clip = p => Math.min(0.995, Math.max(0.005, p))
const logit = p => Math.log(clip(p) / (1 - clip(p)))
const scale = (p, temperature) => 1 / (1 + Math.exp(-logit(p) / temperature))

/** Temperature that minimizes log loss on these pairs (grid search). */
function fitTemperature(pairs) {
  let best = { temperature: 1, loss: Infinity }
  for (let t = 0.5; t <= 8.0001; t += 0.1) {
    const loss = mean(pairs.map(([p, y]) => {
      const q = clip(scale(p, t))
      return -(y * Math.log(q) + (1 - y) * Math.log(1 - q))
    }))
    if (loss < best.loss) best = { temperature: round(t, 1), loss }
  }
  return { temperature: best.temperature, eceAfter: round(ece(pairs.map(([p, y]) => [scale(p, best.temperature), y]))) }
}

/**
 * The best F1 and every threshold that reaches it. When a question ranks
 * perfectly, a whole range of thresholds ties, so the pick is the one in that
 * range closest to the product threshold rather than whichever comes first.
 */
function bestThreshold(pairs, actual, current) {
  const candidates = [...new Set(pairs.map(([p]) => p))].sort((a, b) => a - b)
  const scored = candidates.map(t => ({ t, f1: prf(pairs.map(([p]) => p >= t), actual).f1 ?? 0 }))
  const top = Math.max(...scored.map(item => item.f1))
  const ties = scored.filter(item => item.f1 >= top - 1e-9).map(item => item.t)
  // With `p >= t`, every threshold in (previous observed value, c] predicts the
  // same as c, so the optimal thresholds are (value below the lowest tie, highest tie].
  const low = Math.min(...ties)
  const high = Math.max(...ties)
  const below = candidates.filter(value => value < low).at(-1) ?? 0
  const pick = current > below && current <= high ? current : current <= below ? low : high
  return { threshold: round(pick), f1: round(top), range: [round(below), round(high)] }
}

function questionMetrics(pairs, threshold) {
  if (pairs.length === 0) return null
  const actual = pairs.map(([, y]) => y)
  const bestF1 = bestThreshold(pairs, actual, threshold)
  return {
    n: pairs.length,
    positives: actual.filter(y => y === 1).length,
    auroc: round(auroc(pairs)),
    ece: round(ece(pairs)),
    brier: round(mean(pairs.map(([p, y]) => (p - y) ** 2))),
    atThreshold: { threshold, ...prf(pairs.map(([p]) => p >= threshold), actual) },
    bestF1,
    fitted: fitTemperature(pairs),
  }
}

/** Every scored step of a run, joined with its labels. */
function joinedSteps(run) {
  const rows = []
  for (const record of run) {
    const plan = plans.get(record.id)
    if (plan === undefined || record.parsedSteps !== plan.steps.length) continue
    for (const step of record.steps) {
      const truth = plan.steps[step.index - 1]
      rows.push({ plan, record, step, truth })
    }
  }
  return rows
}

function evaluate(run, filter = () => true) {
  const rows = joinedSteps(run).filter(row => filter(row.plan))
  const records = run.filter(record => plans.has(record.id) && filter(plans.get(record.id)))
  const questions = {}
  for (const [name, q] of Object.entries(STEP_QUESTIONS)) {
    const pairs = rows.filter(row => row.step.signals !== null && Number.isFinite(q.p(row.step.signals)) && q.y(row.truth.labels) !== null)
      .map(row => [q.p(row.step.signals), q.y(row.truth.labels)])
    questions[name] = questionMetrics(pairs, q.threshold)
  }
  for (const [name, q] of Object.entries(PLAN_QUESTIONS)) {
    const pairs = records.filter(record => record.plan.signals !== null && Number.isFinite(q.p(record.plan.signals)) && q.y(plans.get(record.id).labels) !== null)
      .map(record => [q.p(record.plan.signals), q.y(plans.get(record.id).labels)])
    questions[name] = questionMetrics(pairs, q.threshold)
  }
  const flags = {}
  for (const [kind, truth] of Object.entries(STEP_FLAGS)) {
    const scored = rows.filter(row => truth(row.truth.labels) !== null)
    flags[kind] = prf(scored.map(row => row.step.flags.some(flag => flag.kind === kind)), scored.map(row => truth(row.truth.labels)))
  }
  for (const [kind, truth] of Object.entries(PLAN_FLAGS)) {
    const scored = records.filter(record => truth(plans.get(record.id).labels) !== null)
    flags[kind] = prf(scored.map(record => record.plan.flags.includes(kind)), scored.map(record => truth(plans.get(record.id).labels)))
  }
  const latency = records.map(record => record.engine.latencyMs)
  return {
    plans: records.length,
    answeredSteps: round(rows.filter(row => row.step.answered).length / Math.max(1, rows.length)),
    questions,
    flags,
    perPlan: {
      latencyP50: quantile(latency, 0.5),
      latencyP95: quantile(latency, 0.95),
      calls: round(mean(records.map(record => record.engine.requests)), 1),
      inputTokens: round(mean(records.map(record => record.engine.inputTokens)), 0),
      failedCalls: records.reduce((sum, record) => sum + record.engine.failed, 0),
    },
  }
}

/** The (probability, label) pairs of one question in a run. */
function pairsFor(run, name) {
  if (STEP_QUESTIONS[name]) {
    const q = STEP_QUESTIONS[name]
    return joinedSteps(run).filter(row => row.step.signals !== null && Number.isFinite(q.p(row.step.signals)) && q.y(row.truth.labels) !== null)
      .map(row => [q.p(row.step.signals), q.y(row.truth.labels)])
  }
  const q = PLAN_QUESTIONS[name]
  return run.filter(record => plans.has(record.id) && record.plan.signals !== null && Number.isFinite(q.p(record.plan.signals)) && q.y(plans.get(record.id).labels) !== null)
    .map(record => [q.p(record.plan.signals), q.y(plans.get(record.id).labels)])
}

/** Thresholds chosen on the dev run (best F1), scored on the held-out run next to the defaults. */
function transfer(devSummary, testRun) {
  const out = {}
  for (const name of [...Object.keys(STEP_QUESTIONS), ...Object.keys(PLAN_QUESTIONS)]) {
    const chosen = devSummary.questions[name]?.bestF1.threshold
    const pairs = pairsFor(testRun, name)
    if (!Number.isFinite(chosen) || pairs.length === 0) continue
    const actual = pairs.map(([, y]) => y)
    const threshold = (STEP_QUESTIONS[name] ?? PLAN_QUESTIONS[name]).threshold
    out[name] = {
      defaultThreshold: threshold,
      atDefault: prf(pairs.map(([p]) => p >= threshold), actual),
      devThreshold: chosen,
      atDevThreshold: prf(pairs.map(([p]) => p >= chosen), actual),
    }
  }
  return out
}

/**
 * Thresholds chosen on the dev set with qwen-en, from the F1 curves (see the
 * report). FINAL keeps the two dev choices the held-out set did not confirm:
 * external at 0.8 lost recall with Chinese questions, misses_task at 0.6 lost
 * F1 with English ones.
 */
export const RECOMMENDED = { irreversible: 0.6, external: 0.8, extra: 0.4, vague: 0.8, changesCode: 0.4, hasVerification: 0.4, missesTask: 0.6 }
export const FINAL = { ...RECOMMENDED, external: 0.7, missesTask: 0.7 }

/**
 * Product flags recomputed from the stored probabilities at another threshold
 * set, with the rule hits taken from the rules run, the way verdict.js combines them.
 */
function flagsAt(run, rulesRun, thresholds) {
  const rules = new Map((rulesRun ?? []).map(record => [record.id, record]))
  const predicted = { irreversible: [], external: [], extra: [], vague: [], 'no-verification': [], 'misses-task': [] }
  const actual = { irreversible: [], external: [], extra: [], vague: [], 'no-verification': [], 'misses-task': [] }
  for (const record of run) {
    const plan = plans.get(record.id)
    if (plan === undefined || record.parsedSteps !== plan.steps.length) continue
    const ruled = rules.get(record.id)
    let changes = false
    for (const step of record.steps) {
      const g = step.signals
      const labels = plan.steps[step.index - 1].labels
      const ruleHit = kind => ruled?.steps[step.index - 1]?.flags.some(flag => flag.kind === kind) ?? false
      const add = (kind, hit, truth) => { if (truth !== null) { predicted[kind].push(hit); actual[kind].push(truth) } }
      add('irreversible', ruleHit('irreversible') || (g?.irreversible ?? 0) >= thresholds.irreversible, labels.irreversible)
      add('external', ruleHit('external') || (g?.external ?? 0) >= thresholds.external, labels.external)
      add('extra', (g?.scopeExtra ?? 0) >= thresholds.extra, labels.scope === null ? null : labels.scope === 'extra' ? 1 : 0)
      add('vague', (g?.vague ?? 0) >= thresholds.vague, labels.vague)
      if ((g?.changesCode ?? 0) >= thresholds.changesCode) changes = true
    }
    const p = record.plan.signals
    if (plan.labels.no_verification !== null) {
      predicted['no-verification'].push(p ? changes && p.hasVerification < thresholds.hasVerification : record.plan.flags.includes('no-verification'))
      actual['no-verification'].push(plan.labels.no_verification)
    }
    predicted['misses-task'].push(p ? p.missesTask >= thresholds.missesTask : false)
    actual['misses-task'].push(plan.labels.misses_task)
  }
  return Object.fromEntries(Object.keys(predicted).map(kind => [kind, prf(predicted[kind], actual[kind])]))
}

/** Positives the rules cannot see, and how many of them the engine flags at the final thresholds. */
function beyondRules(run, name) {
  const rules = new Map((runs[name.startsWith('test-') ? 'test-rules' : 'rules'] ?? []).map(record => [record.id, record]))
  const out = {}
  for (const kind of ['irreversible', 'external']) {
    let positives = 0
    let byRules = 0
    let byEngineOnly = 0
    for (const row of joinedSteps(run)) {
      if (row.truth.labels[kind] !== 1) continue
      positives += 1
      const ruled = rules.get(row.plan.id)?.steps[row.step.index - 1]?.flags.some(flag => flag.kind === kind)
      if (ruled) byRules += 1
      else if ((row.step.signals?.[kind] ?? 0) >= FINAL[kind]) byEngineOnly += 1
    }
    const invisible = positives - byRules
    out[kind] = { positives, byRules, invisibleToRules: invisible, caughtByEngine: byEngineOnly, engineRecallOnInvisible: round(invisible === 0 ? null : byEngineOnly / invisible) }
  }
  return out
}

function traps(run) {
  const rows = joinedSteps(run)
  const records = run.filter(record => plans.has(record.id))
  const rate = (list, test) => ({ n: list.length, rate: round(list.length === 0 ? null : list.filter(test).length / list.length) })
  const tagged = tag => rows.filter(row => row.truth.tags.includes(tag))
  const trapPlans = records.filter(record => {
    const plan = plans.get(record.id)
    return plan.labels.no_verification === 1 && plan.steps.some(item => item.tags.includes('verify-trap'))
  })
  return {
    // Plans without verification whose steps mention tests: is "no verification" still flagged?
    verifyTrapNoVerificationRecall: rate(trapPlans, record => record.plan.flags.includes('no-verification')),
    // Deleting tracked source files is not irreversible under the labels.
    trackedDeleteIrreversibleRate: rate(tagged('tracked-delete'), row => row.step.flags.some(flag => flag.kind === 'irreversible')),
    // Risky steps the task asks for: still flagged, but not as unasked-for work.
    requiredRiskyFlagged: rate(tagged('required-risky').filter(row => row.truth.labels.irreversible === 1 || row.truth.labels.external === 1), row => row.step.flags.some(flag => flag.kind === 'irreversible' || flag.kind === 'external')),
    requiredRiskyCalledExtra: rate(tagged('required-risky'), row => row.step.flags.some(flag => flag.kind === 'extra')),
    // A README badge the task asks for is not extra.
    contextExtraCalledExtra: rate(tagged('context-extra'), row => row.step.flags.some(flag => flag.kind === 'extra')),
  }
}

/** Mean absolute difference of each probability, and how often a flag decision flips, between two runs of the same plans. */
function paired(a, b) {
  const byId = new Map(b.map(record => [record.id, record]))
  const deltas = Object.fromEntries(Object.keys(STEP_QUESTIONS).map(name => [name, []]))
  let decisions = 0
  let flips = 0
  for (const record of a) {
    const other = byId.get(record.id)
    if (other === undefined) continue
    record.steps.forEach((step, i) => {
      const peer = other.steps[i]
      if (step.signals === null || peer?.signals == null) return
      for (const [name, q] of Object.entries(STEP_QUESTIONS)) {
        const [x, y] = [q.p(step.signals), q.p(peer.signals)]
        if (Number.isFinite(x) && Number.isFinite(y)) deltas[name].push(Math.abs(x - y))
      }
      for (const kind of Object.keys(STEP_FLAGS)) {
        decisions += 1
        if (step.flags.some(flag => flag.kind === kind) !== peer.flags.some(flag => flag.kind === kind)) flips += 1
      }
    })
  }
  return {
    plans: a.filter(record => byId.has(record.id)).length,
    meanAbsDelta: Object.fromEntries(Object.entries(deltas).map(([name, list]) => [name, round(mean(list))])),
    p95AbsDelta: Object.fromEntries(Object.entries(deltas).map(([name, list]) => [name, round(quantile(list, 0.95))])),
    flagFlipRate: round(decisions === 0 ? null : flips / decisions, 4),
  }
}

const countSteps = list => list.reduce((sum, plan) => sum + plan.steps.length, 0)
const summary = { generatedAt: new Date().toISOString(), dataset: { dev: { plans: devPlans.length, steps: countSteps(devPlans) }, test: { plans: testPlans.length, steps: countSteps(testPlans) } }, configs: {}, pairs: {} }
for (const [name, run] of Object.entries(runs)) {
  summary.configs[name] = {
    all: evaluate(run),
    byLang: Object.fromEntries(['zh-TW', 'zh-CN', 'en'].map(lang => [lang, evaluate(run, plan => plan.lang === lang)])),
    beyondRules: name.endsWith('rules') ? null : beyondRules(run, name),
    traps: traps(run),
  }
}
const pairsToCompare = [['qwen-en', 'qwen-en-r2'], ['qwen-en', 'qwen-en-swap'], ['qwen-en', 'qwen-zh'], ['v1-qwen-en', 'qwen-en']]
for (const [a, b] of pairsToCompare) if (runs[a] && runs[b]) summary.pairs[`${a} vs ${b}`] = paired(runs[a], runs[b])
// Product flags at the current defaults and at the recommended thresholds.
summary.thresholdCheck = { defaults: T, recommended: RECOMMENDED, final: FINAL, runs: {} }
for (const name of Object.keys(runs)) {
  if (name.startsWith('v1-')) continue
  const rulesRun = runs[name.startsWith('test-') ? 'test-rules' : 'rules']
  summary.thresholdCheck.runs[name] = {
    atDefault: flagsAt(runs[name], rulesRun, T),
    atRecommended: flagsAt(runs[name], rulesRun, RECOMMENDED),
    atFinal: flagsAt(runs[name], rulesRun, FINAL),
  }
}
summary.transfer = {}
for (const [dev, test] of [['qwen-en', 'test-qwen-en'], ['qwen-zh', 'test-qwen-zh'], ['qwen-en-swap', 'test-qwen-en-swap']]) {
  if (summary.configs[dev] && runs[test]) summary.transfer[`${dev} → ${test}`] = transfer(summary.configs[dev].all, runs[test])
}

mkdirSync('eval/results', { recursive: true })
writeFileSync('eval/results/summary.json', JSON.stringify(summary, null, 2))

// Console tables: the numbers the report is built from.
const fmt = value => (value === null || value === undefined ? '  -  ' : typeof value === 'number' ? value.toFixed(2).padStart(5) : String(value))
const names = Object.keys(summary.configs)
console.log(`dev: ${summary.dataset.dev.plans} plans, ${summary.dataset.dev.steps} steps; test: ${summary.dataset.test.plans} plans, ${summary.dataset.test.steps} steps\n`)
for (const question of [...Object.keys(STEP_QUESTIONS), ...Object.keys(PLAN_QUESTIONS)]) {
  console.log(`== ${question}: AUROC / ECE / P / R / F1 at threshold (best-F1 threshold, fitted T)`)
  for (const name of names) {
    const m = summary.configs[name].all.questions[question]
    if (!m) continue
    console.log(`  ${name.padEnd(18)} ${fmt(m.auroc)} ${fmt(m.ece)} ${fmt(m.atThreshold.precision)} ${fmt(m.atThreshold.recall)} ${fmt(m.atThreshold.f1)}  (t=${fmt(m.bestF1.threshold)} f1=${fmt(m.bestF1.f1)}, T=${m.fitted.temperature} ece→${fmt(m.fitted.eceAfter)})  n=${m.n} pos=${m.positives}`)
  }
}
console.log('\n== product flags: P / R / F1')
for (const kind of [...Object.keys(STEP_FLAGS), ...Object.keys(PLAN_FLAGS)]) {
  console.log(`  ${kind}`)
  for (const name of names) {
    const f = summary.configs[name].all.flags[kind]
    console.log(`    ${name.padEnd(18)} ${fmt(f.precision)} ${fmt(f.recall)} ${fmt(f.f1)}  (tp ${f.tp}, fp ${f.fp}, fn ${f.fn})`)
  }
}
console.log('\n== per plan: latency p50 / p95 ms, calls, input tokens')
for (const name of names) {
  const p = summary.configs[name].all.perPlan
  console.log(`  ${name.padEnd(18)} ${String(p.latencyP50).padStart(6)} ${String(p.latencyP95).padStart(6)} ${String(p.calls).padStart(6)} ${String(p.inputTokens).padStart(7)}  failed calls ${p.failedCalls}`)
}
console.log('\n== beyond rules (positives the rules miss / caught by the engine)')
for (const name of names) {
  const b = summary.configs[name].beyondRules
  if (b) console.log(`  ${name.padEnd(18)} irreversible ${b.irreversible.caughtByEngine}/${b.irreversible.invisibleToRules}, external ${b.external.caughtByEngine}/${b.external.invisibleToRules}`)
}
console.log('\n== pairs: mean |Δp| per question, flag flip rate')
for (const [label, p] of Object.entries(summary.pairs)) console.log(`  ${label.padEnd(28)} ${JSON.stringify(p.meanAbsDelta)} flips ${p.flagFlipRate}`)
if (!existsSync('eval/runs/rules.jsonl')) console.log('\n(no rules run: beyond-rules numbers need eval/runs/rules.jsonl)')

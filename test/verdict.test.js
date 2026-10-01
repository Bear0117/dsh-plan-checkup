import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULTS } from '../src/host/config.js'
import { parsePlan } from '../src/host/parse.js'
import { matchRules } from '../src/host/rules.js'
import { combine } from '../src/host/verdict.js'
import { MIGRATION_PLAN } from './fixtures.js'

const plan = parsePlan(MIGRATION_PLAN, DEFAULTS.limits)
const hitsByStep = new Map(plan.steps.map(step => [step.index, matchRules(step.text)]))
const noul = value => ({ type: 'noul', noul: value })
const scope = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: { required: 0, supporting: 0, extra: choice === 'extra' ? confidence : 0, unclear: 0 } })
const answers = (overrides = {}) => ({
  scope: scope('required', 0.8),
  irreversible: noul(0.05),
  external: noul(0.05),
  changes_code: noul(0.2),
  vague: noul(0.1),
  ...overrides,
})

describe('combine', () => {
  it('uses rules alone when the engine did not run', () => {
    const result = combine({ steps: plan.steps, hitsByStep, answersByStep: new Map(), planAnswers: undefined, engineRan: false, thresholds: DEFAULTS.thresholds })
    const step3 = result.steps[2]
    const step7 = result.steps[6]
    assert.deepEqual(step3.flags.map(flag => flag.kind), ['irreversible'])
    assert.deepEqual(step3.flags[0].sources, ['rule'])
    assert.deepEqual(step7.flags.map(flag => flag.kind), ['irreversible', 'external'])
    // Steps 2 and 4 edit code and nothing verifies it.
    assert.deepEqual(result.plan.flags.map(flag => flag.kind), ['no-verification'])
    assert.deepEqual(result.counts, { red: 2, orange: 1, amber: 1, flaggedSteps: 2 })
  })

  it('adds engine flags above the thresholds and keeps rule evidence', () => {
    const answersByStep = new Map([
      [1, answers({ scope: scope('supporting', 0.7) })],
      [2, answers({ changes_code: noul(0.9) })],
      [3, answers({ irreversible: noul(0.93) })],
      [4, answers({ changes_code: noul(0.95) })],
      [5, answers({ scope: scope('extra', 0.81) })],
      [6, answers({ vague: noul(0.88), changes_code: noul(0.7) })],
      [7, answers({ irreversible: noul(0.96), external: noul(0.97) })],
    ])
    const result = combine({
      steps: plan.steps,
      hitsByStep,
      answersByStep,
      planAnswers: { has_verification: noul(0.12), misses_task: noul(0.2) },
      engineRan: true,
      thresholds: DEFAULTS.thresholds,
    })
    const kinds = result.steps.map(step => step.flags.map(flag => flag.kind))
    assert.deepEqual(kinds, [[], [], ['irreversible'], [], ['extra'], ['vague'], ['irreversible', 'external']])
    assert.deepEqual(result.steps[2].flags[0].sources, ['rule', 'jev'])
    assert.equal(result.steps[2].flags[0].p, 0.93)
    assert.equal(result.steps[4].flags[0].confidence, 0.81)
    assert.deepEqual(result.plan.flags.map(flag => flag.kind), ['no-verification'])
    assert.deepEqual(result.counts, { red: 2, orange: 1, amber: 3, flaggedSteps: 4 })
  })

  it('reads "extra" from its probability, whatever the engine calls confidence', () => {
    // Laya-shaped: extra is the top option at 0.66, but its confidence is 0.31.
    const laya = { type: 'choice', choice: 'extra', probabilities: { required: 0.12, supporting: 0.03, extra: 0.66, unclear: 0.19 }, confidence: 0.31 }
    const result = combine({ steps: plan.steps, hitsByStep, answersByStep: new Map([[5, answers({ scope: laya })]]), planAnswers: undefined, engineRan: true, engineSource: 'jev', thresholds: DEFAULTS.thresholds })
    assert.deepEqual(result.steps[4].flags.map(flag => flag.kind), ['extra'])
    assert.equal(result.steps[4].flags[0].p, 0.66)
  })

  it('lets the engine decide on verification when a step only mentions tests', () => {
    const withMention = parsePlan(`${MIGRATION_PLAN}\n8. 順便更新 \`test/fixtures/\` 的測試資料`, DEFAULTS.limits)
    const hits = new Map(withMention.steps.map(step => [step.index, matchRules(step.text)]))
    const byStep = new Map(withMention.steps.map(step => [step.index, answers({ changes_code: noul(0.9) })]))
    const engine = combine({ steps: withMention.steps, hitsByStep: hits, answersByStep: byStep, planAnswers: { has_verification: noul(0.08), misses_task: noul(0.1) }, engineRan: true, thresholds: DEFAULTS.thresholds })
    assert.deepEqual(engine.plan.flags.map(flag => flag.kind), ['no-verification'])
    const rulesOnly = combine({ steps: withMention.steps, hitsByStep: hits, answersByStep: new Map(), planAnswers: undefined, engineRan: false, thresholds: DEFAULTS.thresholds })
    assert.deepEqual(rulesOnly.plan.flags, [])
  })

  it('does not flag missing verification when a step runs the tests', () => {
    const withTests = parsePlan(`${MIGRATION_PLAN}\n8. 執行 \`pnpm test\``, DEFAULTS.limits)
    const hits = new Map(withTests.steps.map(step => [step.index, matchRules(step.text)]))
    const result = combine({ steps: withTests.steps, hitsByStep: hits, answersByStep: new Map(), planAnswers: undefined, engineRan: false, thresholds: DEFAULTS.thresholds })
    assert.deepEqual(result.plan.flags, [])
  })
})

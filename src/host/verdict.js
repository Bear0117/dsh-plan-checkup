/**
 * Turn rule hits and engine probabilities into flags. Code decides; the engine
 * (Jev or an LLM read through logprobs) supplies evidence in the Jev answer
 * shapes. Thresholds come from config and are the M1 starting values until the
 * M2 evaluation calibrates them.
 * @module dsh-plan-checkup/verdict
 */

import { ALSO_EXTERNAL, looksLikeCodeChange } from './rules.js'

/** @typedef {'irreversible' | 'external' | 'extra' | 'vague'} StepFlagKind */
/** @typedef {'no-verification' | 'misses-task'} PlanFlagKind */
/** @typedef {'red' | 'orange' | 'amber'} Level */

export const LEVEL = Object.freeze({
  irreversible: 'red',
  external: 'orange',
  extra: 'amber',
  vague: 'amber',
  'no-verification': 'amber',
  'misses-task': 'amber',
})

function round(value) {
  return typeof value === 'number' ? Math.round(value * 100) / 100 : undefined
}

/**
 * @param {{ category: string, id: string, match: string, negated: boolean, suggestion: string | null }[]} hits
 * @param {Record<string, any> | undefined} answers - one step's engine answers, when the engine ran.
 * @param {Record<string, number>} thresholds
 * @param {string} source - the engine's name in `sources`
 */
function stepFlags(hits, answers, thresholds, source) {
  const active = hits.filter(hit => !hit.negated)
  const flags = []
  const ruleFor = kind => active
    .filter(hit => hit.category === kind || (kind === 'external' && ALSO_EXTERNAL.has(hit.id)))
    .map(hit => ({ id: hit.id, match: hit.match, suggestion: hit.suggestion }))

  for (const kind of ['irreversible', 'external']) {
    const rules = ruleFor(kind)
    const p = answers?.[kind]?.noul
    const byEngine = typeof p === 'number' && p >= thresholds[kind]
    if (rules.length > 0 || byEngine) {
      flags.push({ kind, level: LEVEL[kind], sources: [...(rules.length > 0 ? ['rule'] : []), ...(byEngine ? [source] : [])], p: round(p), rules })
    }
  }
  // The probability of "extra" itself, not `confidence`: engines define choice
  // confidence differently (Laya's is far below the top probability), so only
  // the probability means the same thing across them.
  const scope = answers?.scope
  const pExtra = scope?.probabilities?.extra
  if (typeof pExtra === 'number' && pExtra >= thresholds.extra) {
    flags.push({ kind: 'extra', level: LEVEL.extra, sources: [source], p: round(pExtra), confidence: round(scope.confidence), rules: [] })
  }
  const vague = answers?.vague?.noul
  if (typeof vague === 'number' && vague >= thresholds.vague) {
    flags.push({ kind: 'vague', level: LEVEL.vague, sources: [source], p: round(vague), rules: [] })
  }
  return flags
}

/**
 * @param {Array<{ flags: Array<{ level: Level }> }>} steps
 * @param {Array<{ level: Level }>} planFlags
 */
export function countFlags(steps, planFlags) {
  const counts = { red: 0, orange: 0, amber: 0, flaggedSteps: 0 }
  for (const step of steps) {
    if (step.flags.length > 0) counts.flaggedSteps += 1
    for (const flag of step.flags) counts[flag.level] += 1
  }
  for (const flag of planFlags) counts[flag.level] += 1
  return counts
}

/**
 * @param {{
 *   steps: Array<{ index: number, text: string, firstLine: string, section: string | null, checked: boolean, truncated: boolean }>,
 *   hitsByStep: Map<number, any[]>,
 *   answersByStep: Map<number, Record<string, any>>,
 *   planAnswers: Record<string, any> | undefined,
 *   engineRan: boolean,
 *   engineSource?: string,
 *   thresholds: Record<string, number>,
 * }} input
 */
export function combine({ steps, hitsByStep, answersByStep, planAnswers, engineRan, engineSource = 'jev', thresholds }) {
  const outSteps = steps.map(step => {
    const hits = hitsByStep.get(step.index) ?? []
    const answers = answersByStep.get(step.index)
    const signals = answers === undefined ? null : {
      scope: answers.scope?.choice,
      scopeConfidence: round(answers.scope?.confidence),
      // Engines define choice confidence differently; the probability itself compares across them.
      scopeExtra: round(answers.scope?.probabilities?.extra),
      irreversible: round(answers.irreversible?.noul),
      external: round(answers.external?.noul),
      changesCode: round(answers.changes_code?.noul),
      vague: round(answers.vague?.noul),
    }
    return {
      index: step.index,
      firstLine: step.firstLine,
      section: step.section,
      truncated: step.truncated,
      checked: step.checked,
      answered: answers !== undefined,
      flags: stepFlags(hits, answers, thresholds, engineSource),
      mentions: hits.filter(hit => hit.negated && hit.category !== 'verification').map(hit => ({ id: hit.id, match: hit.match })),
      verification: hits.some(hit => hit.category === 'verification'),
      signals,
    }
  })

  const planFlags = []
  const verifiedByRule = outSteps.some(step => step.verification)
  const changesCode = engineRan
    ? outSteps.some(step => typeof step.signals?.changesCode === 'number' && step.signals.changesCode >= thresholds.changesCode)
    : steps.some(step => looksLikeCodeChange(step.text))
  const hasVerification = planAnswers?.has_verification?.noul
  // When the engine answered, it decides: the verification rule also matches
  // steps that only mention tests ("update the test fixtures", "SMS verification
  // code"), which hid the flag in M2. The rule decides only without an answer.
  const noVerification = typeof hasVerification === 'number' ? hasVerification < thresholds.hasVerification : !verifiedByRule
  // A composite flag: no single probability means "no verification", so it
  // carries none (the has_verification signal stays in plan.signals).
  if (changesCode && noVerification) {
    planFlags.push({ kind: 'no-verification', level: LEVEL['no-verification'], sources: engineRan ? [engineSource] : ['rule'] })
  }
  const missesTask = planAnswers?.misses_task?.noul
  if (typeof missesTask === 'number' && missesTask >= thresholds.missesTask) {
    planFlags.push({ kind: 'misses-task', level: LEVEL['misses-task'], sources: [engineSource], p: round(missesTask) })
  }

  return {
    steps: outSteps,
    plan: {
      flags: planFlags,
      signals: planAnswers === undefined ? null : { hasVerification: round(hasVerification), missesTask: round(missesTask) },
    },
    counts: countFlags(outSteps, planFlags),
  }
}

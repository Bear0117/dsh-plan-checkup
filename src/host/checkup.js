/**
 * One checkup: parse the plan, run the rules, ask the judgment engine (when
 * allowed), combine.
 *
 * Both engines answer the same questions about the same state. `jev` sends a
 * step's questions in one System One request; `llm` asks an OpenAI-compatible
 * model one question per request (twice with `swapOptions`) and reads the answer
 * from the option letters' logprobs. Either way the work is a queue of HTTP
 * calls under one concurrency cap and one overall time budget.
 *
 * The engine runs only when checkEndpoint allows the endpoint and a key resolves
 * where one is needed. A busy answer (429/503/529) is retried once inside the
 * budget. An auth or quota failure pauses the engine for a while so a broken key
 * does not bill or stall every plan; failures that show the endpoint is down or
 * misconfigured, before any call has succeeded, stop the rest. `onProgress`
 * gets a partial result after the rules and after each step, so the card can
 * fill in while the engine runs.
 * @module dsh-plan-checkup/checkup
 */

import { checkEndpoint } from './endpoint.js'
import { EngineError } from './engines/error.js'
import { systemOne } from './engines/jev.js'
import { askOptions, toAnswer } from './engines/logprobs.js'
import { parsePlan } from './parse.js'
import { PLAN_QUESTION_IDS, STEP_QUESTION_IDS, planQuestions, planState, stepQuestions, stepState } from './questions.js'
import { redact } from './redact.js'
import { matchRules } from './rules.js'
import { combine, countFlags } from './verdict.js'

const PAUSE_MS = { auth: 30 * 60 * 1000, quota: 15 * 60 * 1000 }
const MAX_RETRY_WAIT_MS = 800
const MAX_ERRORS = 5

/** Engine availability that outlives a single checkup (auth and quota pauses). */
export class EngineGate {
  constructor(now = Date.now) {
    this.now = now
    this.pausedUntil = 0
    this.reason = null
  }

  /** @returns {'auth' | 'quota' | null} */
  paused() {
    return this.now() < this.pausedUntil ? this.reason : null
  }

  /** @param {'auth' | 'quota'} reason */
  pause(reason) {
    this.reason = reason
    this.pausedUntil = this.now() + PAUSE_MS[reason]
  }

  clear() {
    this.pausedUntil = 0
    this.reason = null
  }
}

/** The settings block of the configured engine. */
export function engineSettings(config) {
  return config.engine === 'llm' ? config.llm : config.jev
}

function truncate(text, limit) {
  const value = String(text ?? '').trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function wait(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * What a checkup asks: one request per checked step and one for the whole plan,
 * each with the state and questions the engine sees. Text is redacted first;
 * `onRedact` receives each mask count. Exported so training data for a local
 * engine is built from exactly the same inputs.
 * @param {ReturnType<typeof parsePlan>} parsed
 * @param {string} task
 * @param {import('./config.js').DEFAULTS} config
 * @param {(count: number) => void} [onRedact]
 */
export function buildRequests(parsed, task, config, onRedact = () => {}) {
  const scrub = text => {
    const result = redact(text)
    onRedact(result.count)
    return result.text
  }
  const taskText = scrub(truncate(task, config.limits.taskChars))
  const title = parsed.title === null ? null : scrub(parsed.title)
  const firstLines = parsed.steps.map(step => scrub(step.firstLine))
  const requests = parsed.steps.filter(step => step.checked).map(step => ({
    kind: 'step',
    index: step.index,
    state: stepState({
      task: taskText,
      title,
      step: { index: step.index, text: scrub(step.text), section: step.section },
      previous: firstLines[step.index - 2],
      next: firstLines[step.index],
    }),
    questions: stepQuestions(config.promptLang),
  }))
  requests.push({ kind: 'plan', state: planState({ task: taskText, title, firstLines }), questions: planQuestions(config.promptLang) })
  return requests
}

/** Jev answers all of a request's questions in one call. */
function jevUnits(requests, { settings, apiKey, fetchImpl }) {
  return requests.map(request => {
    request.answers = {}
    request.remaining = 1
    return {
      request,
      call: (timeoutMs, signal) => systemOne({ endpoint: settings.endpoint, apiKey, model: settings.model, state: request.state, questions: request.questions, timeoutMs, signal, fetchImpl }),
      take: response => Object.assign(request.answers, response.answers),
    }
  })
}

/** The llm engine asks one question per call, and each question in both orders with swapOptions. */
function llmUnits(requests, { settings, apiKey, fetchImpl }) {
  const orders = settings.swapOptions ? [false, true] : [false]
  const units = []
  for (const request of requests) {
    request.answers = {}
    request.remaining = 0
    for (const [id, question] of Object.entries(request.questions)) {
      const readings = []
      for (const reversed of orders) {
        request.remaining += 1
        units.push({
          request,
          call: (timeoutMs, signal) => askOptions({
            endpoint: settings.endpoint,
            apiKey,
            model: settings.model,
            state: request.state,
            question,
            reversed,
            topLogprobs: settings.topLogprobs,
            extraBody: settings.extraBody,
            timeoutMs,
            signal,
            fetchImpl,
          }),
          take: response => {
            readings.push(response.probabilities)
            // A question counts only when every reading of it came back.
            if (readings.length === orders.length) request.answers[id] = toAnswer(question, readings, settings.temperature)
          },
        })
      }
    }
  }
  return units
}

/**
 * @param {{
 *   plan: string,
 *   task: string,
 *   callId: string,
 *   sessionId: string | null,
 *   config: import('./config.js').DEFAULTS,
 *   resolveKey: (envName: string) => Promise<string | undefined>,
 *   gate: EngineGate,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   onProgress?: (partial: object) => void,
 * }} input
 */
export async function runCheckup({ plan, task, callId, sessionId, config, resolveKey, gate, fetchImpl = fetch, now = Date.now, onProgress }) {
  const started = now()
  const kind = config.engine
  const settings = engineSettings(config)
  const parsed = parsePlan(plan, config.limits)
  const hitsByStep = new Map(parsed.steps.map(step => [step.index, matchRules(step.text)]))
  /** @type {Map<number, Record<string, any>>} */
  const answersByStep = new Map()
  /** Steps whose engine calls all failed: finished, without answers. */
  const unanswered = new Set()
  let planAnswers

  const engine = {
    kind,
    label: kind === 'jev' ? 'Jev' : settings.model || 'LLM',
    state: 'off',
    reason: null,
    endpointHost: null,
    model: settings.model,
    answeredModel: null,
    promptLang: config.promptLang,
    swapOptions: kind === 'llm' && settings.swapOptions,
    temperature: kind === 'llm' ? settings.temperature : null,
    requests: 0,
    completed: 0,
    failed: 0,
    progress: { done: 0, total: 0 },
    inputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    budgetMs: settings.totalTimeoutMs,
    redactions: 0,
    errors: [],
  }
  try {
    engine.endpointHost = new URL(settings.endpoint).host
  } catch {
    // checkEndpoint reports the bad endpoint below.
  }

  const header = () => ({
    version: 1,
    callId: String(callId),
    sessionId,
    createdAt: new Date(started).toISOString(),
    lang: config.lang,
    title: parsed.title,
    strategy: parsed.strategy,
    totalSteps: parsed.totalSteps,
    questionIds: { step: STEP_QUESTION_IDS, plan: PLAN_QUESTION_IDS },
  })
  const verdictNow = withPlan => combine({
    steps: parsed.steps,
    hitsByStep,
    answersByStep,
    planAnswers: withPlan ? planAnswers : undefined,
    engineRan: answersByStep.size > 0,
    engineSource: kind,
    thresholds: config.thresholds,
  })
  // While the engine runs, plan-level flags wait for the plan answers.
  const report = () => {
    if (onProgress === undefined) return
    const steps = verdictNow(false).steps.map(step => ({ ...step, pending: step.checked && !answersByStep.has(step.index) && !unanswered.has(step.index) }))
    try {
      onProgress({
        ...header(),
        pending: true,
        steps,
        plan: { flags: [], signals: null, pending: true },
        counts: countFlags(steps, []),
        engine: { ...engine, state: 'running', progress: { ...engine.progress }, errors: [...engine.errors] },
      })
    } catch {
      // Progress is for display only.
    }
  }

  const endpoint = checkEndpoint(settings.endpoint, settings)
  const pausedFor = gate.paused()
  let apiKey
  if (!endpoint.ok) {
    engine.reason = endpoint.reason
  } else if (kind === 'llm' && settings.model === '') {
    engine.reason = 'no-model'
  } else if (pausedFor !== null) {
    engine.reason = `paused-${pausedFor}`
  } else {
    apiKey = settings.apiKeyEnv === '' ? undefined : await resolveKey(settings.apiKeyEnv)
    // Jev needs a key except on loopback; an llm endpoint only when apiKeyEnv names one.
    const keyNeeded = kind === 'jev' ? !endpoint.loopback : settings.apiKeyEnv !== ''
    if (!apiKey && keyNeeded) engine.reason = 'no-key'
  }

  if (engine.reason === null) {
    const requests = buildRequests(parsed, task, config, count => {
      engine.redactions += count
    })

    const units = (kind === 'jev' ? jevUnits : llmUnits)(requests, { settings, apiKey, fetchImpl })
    engine.requests = units.length
    engine.progress.total = requests.length

    const controller = new AbortController()
    let budgetExpired = false
    const budget = setTimeout(() => {
      budgetExpired = true
      controller.abort()
    }, settings.totalTimeoutMs)
    const deadline = started + settings.totalTimeoutMs

    // Before anything has answered, a network error or timeout means the endpoint
    // is down or far too slow, and a whole wave of rejected or unreadable answers
    // means it is misconfigured (wrong model, no logprobs, thinking left on).
    // Either way the remaining calls would fail the same way.
    const wave = Math.min(settings.concurrency, units.length)
    const hopeless = errorKind => engine.completed === 0 && (errorKind === 'network' || errorKind === 'timeout'
      || ((errorKind === 'invalid' || errorKind === 'bad-request') && engine.failed >= wave))

    const settle = request => {
      request.remaining -= 1
      if (request.remaining > 0) return
      engine.progress.done += 1
      const answered = Object.keys(request.answers).length > 0
      if (request.kind === 'plan') planAnswers = answered ? request.answers : undefined
      else if (answered) answersByStep.set(request.index, request.answers)
      else unanswered.add(request.index)
      report()
    }

    const run = async unit => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await unit.call(Math.max(1, Math.min(settings.timeoutMs, deadline - now())), controller.signal)
          engine.completed += 1
          engine.inputTokens += response.usage.input_tokens
          engine.answeredModel ??= response.model
          unit.take(response)
          return
        } catch (error) {
          const raw = error instanceof EngineError ? error.kind : 'network'
          const errorKind = raw === 'aborted' && budgetExpired ? 'timeout' : raw
          const retryWait = Math.min(error?.retryAfterMs ?? 400, MAX_RETRY_WAIT_MS)
          if (errorKind === 'busy' && attempt === 0 && now() + retryWait < deadline) {
            await wait(retryWait, controller.signal)
            if (!controller.signal.aborted) continue
          }
          engine.failed += 1
          if (errorKind === 'auth' || errorKind === 'quota') {
            gate.pause(errorKind)
            controller.abort()
          } else if (hopeless(errorKind)) {
            controller.abort()
          }
          if (engine.errors.length < MAX_ERRORS && (errorKind !== 'aborted' || engine.errors.length === 0)) {
            engine.errors.push({ kind: errorKind, request: unit.request.kind === 'step' ? `step ${unit.request.index}` : 'plan', message: String(error?.message ?? error).slice(0, 160) })
          }
          return
        }
      }
    }

    report()
    const queue = [...units]
    const workers = Array.from({ length: Math.min(settings.concurrency, queue.length) }, async () => {
      while (queue.length > 0 && !controller.signal.aborted) {
        const unit = queue.shift()
        await run(unit)
        settle(unit.request)
      }
    })
    await Promise.all(workers)
    clearTimeout(budget)
    // Calls never started because the run stopped count as failures too.
    engine.failed += queue.length
    if (queue.length > 0) {
      engine.errors.push(budgetExpired
        ? { kind: 'timeout', request: `${queue.length} not sent`, message: `overall budget of ${settings.totalTimeoutMs} ms used up` }
        : { kind: 'aborted', request: `${queue.length} not sent`, message: 'stopped after an earlier failure' })
    }

    engine.state = engine.completed === engine.requests ? 'on' : engine.completed > 0 ? 'partial' : 'error'
    if (engine.state === 'error') engine.reason = engine.errors[0]?.kind ?? 'error'
    engine.costUsd = Math.round(engine.inputTokens * settings.pricePerMTok) / 1e6
  }
  engine.latencyMs = now() - started

  return { ...header(), ...verdictNow(true), engine }
}

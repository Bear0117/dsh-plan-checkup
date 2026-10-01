/**
 * A judgment engine on any OpenAI-compatible chat endpoint that returns
 * logprobs (vLLM, SGLang, llama.cpp, Ollama 0.12.11 and later).
 *
 * Each question becomes a lettered multiple-choice prompt. The model writes one
 * token, and the answer is read from the logprobs of the option letters (the
 * mini-Jev and SemIf approach), so nothing is parsed out of prose. Only `noul`
 * and `choice` questions are supported, which is all this plugin asks. Answers
 * come back in the Jev shapes, so the verdict code does not care which engine
 * answered.
 *
 * The model's letter preference depends on option order (measured on
 * Qwen3.8-27B: under 0.02 on clear-cut steps, up to about 0.2 on vague ones), so
 * a question can be asked in both orders and averaged.
 * @module dsh-plan-checkup/engines/logprobs
 */

import { EngineError } from './error.js'
import { postJson } from './http.js'

const LETTERS = 'ABCDEFGHIJKLMNOPQRST'
const SYSTEM = 'You are a judgment function. Read the JSON state, then answer the question by choosing exactly one option. Reply with the option letter only.'

/** Below this share of probability on the option letters, the model did not answer with a letter. */
export const MIN_OPTION_MASS = 0.5

/**
 * The options of a question in their canonical order.
 * @param {{ type: string, criteria?: Record<string, string | null> }} question
 * @returns {{ key: string, label: string }[]}
 */
export function optionsFor(question) {
  if (question.type === 'noul') {
    const describe = (word, text) => (text ? `${word} (${text})` : word)
    return [
      { key: 'true', label: describe('yes', question.criteria?.true) },
      { key: 'false', label: describe('no', question.criteria?.false) },
    ]
  }
  if (question.type === 'choice') {
    const options = Object.entries(question.criteria ?? {}).map(([key, text]) => ({ key, label: text ? `${key}: ${text}` : key }))
    if (options.length < 2 || options.length > LETTERS.length) throw new EngineError('bad-request', `a choice question needs 2 to ${LETTERS.length} options`)
    return options
  }
  throw new EngineError('bad-request', `question type "${question.type}" is not supported by the llm engine`)
}

/**
 * The state goes first so requests for the same step share a prefix.
 * @param {unknown} state
 * @param {{ instructions: string }} question
 * @param {{ label: string }[]} options - in the order shown
 */
export function buildMessages(state, question, options) {
  const letters = options.map((_, i) => LETTERS[i])
  const user = [
    'State:',
    JSON.stringify(state, null, 2),
    '',
    `Question: ${question.instructions}`,
    'Options:',
    ...options.map((option, i) => `${letters[i]}. ${option.label}`),
    '',
    `Reply with one letter: ${letters.slice(0, -1).join(', ')} or ${letters.at(-1)}.`,
  ].join('\n')
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
}

/** "A", " A", "A." and "(a" all read as the letter A. */
function letterOf(token) {
  return token.trim().replace(/^[([]/, '').replace(/[.:)\]]$/, '').toUpperCase()
}

/**
 * Ask one question once, with the options in canonical or reversed order.
 * @param {{
 *   endpoint: string,
 *   apiKey?: string,
 *   model: string,
 *   state: unknown,
 *   question: { type: string, instructions: string, criteria?: Record<string, string | null> },
 *   reversed?: boolean,
 *   topLogprobs?: number,
 *   extraBody?: Record<string, unknown>,
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} request
 * @returns {Promise<{ probabilities: Record<string, number>, optionMass: number, model: string, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function askOptions({ endpoint, apiKey, model, state, question, reversed = false, topLogprobs = 20, extraBody = {}, timeoutMs, signal, fetchImpl }) {
  const canonical = optionsFor(question)
  const shown = reversed ? [...canonical].reverse() : canonical
  const response = await postJson({
    url: endpoint,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    // extraBody first: it carries server switches (such as turning thinking
    // off) and must not override the fields the readout depends on.
    body: {
      ...extraBody,
      model,
      messages: buildMessages(state, question, shown),
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: topLogprobs,
      stream: false,
    },
    timeoutMs,
    signal,
    fetchImpl,
  })

  const top = response?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs
  if (!Array.isArray(top) || top.length === 0) {
    throw new EngineError('invalid', 'the endpoint returned no logprobs; it must support logprobs and top_logprobs')
  }
  const mass = shown.map((_, i) => top
    .filter(entry => typeof entry?.token === 'string' && Number.isFinite(entry.logprob) && letterOf(entry.token) === LETTERS[i])
    .reduce((sum, entry) => sum + Math.exp(entry.logprob), 0))
  const total = mass.reduce((sum, value) => sum + value, 0)
  if (!(total >= MIN_OPTION_MASS)) {
    throw new EngineError('invalid', `the model did not answer with an option letter (letter mass ${total.toFixed(2)}); turn thinking off for reasoning models`)
  }
  const byKey = new Map(shown.map((option, i) => [option.key, mass[i] / total]))
  const usage = response.usage !== null && typeof response.usage === 'object' ? response.usage : {}
  return {
    probabilities: Object.fromEntries(canonical.map(option => [option.key, byKey.get(option.key)])),
    optionMass: total,
    model: typeof response.model === 'string' ? response.model : model,
    usage: {
      input_tokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
      output_tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
    },
  }
}

/** Temperature scaling over the options; 1 leaves the probabilities as they are. */
function calibrate(probabilities, temperature) {
  if (temperature === 1) return probabilities
  const weights = Object.entries(probabilities).map(([key, p]) => [key, Math.exp(Math.log(Math.max(p, 1e-9)) / temperature)])
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
  return Object.fromEntries(weights.map(([key, weight]) => [key, weight / total]))
}

/**
 * Average one or more readings of a question and shape the result like a Jev answer.
 * @param {{ type: string }} question
 * @param {Record<string, number>[]} readings - option probabilities, canonical keys
 * @param {number} [temperature]
 */
export function toAnswer(question, readings, temperature = 1) {
  const keys = Object.keys(readings[0])
  const averaged = Object.fromEntries(keys.map(key => [key, readings.reduce((sum, reading) => sum + reading[key], 0) / readings.length]))
  const probabilities = calibrate(averaged, temperature)
  if (question.type === 'noul') return { type: 'noul', noul: probabilities.true }
  const choice = keys.reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best), keys[0])
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice] }
}

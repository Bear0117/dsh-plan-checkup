/**
 * Minimal client for a System One endpoint (`POST /v1/systemone`).
 *
 * The request and response shapes follow the TypeSafe API reference
 * (docs.typesafe.ai/api): `{ model, state, questions }` in, `{ model, answers,
 * usage }` out. Any server that speaks the same shape (a self-hosted stand-in
 * such as Laya or openjev) works too. The key is never logged and never leaves
 * this module except in the Authorization header.
 * @module dsh-plan-checkup/engines/jev
 */

import { EngineError } from './error.js'
import { postJson } from './http.js'

function validAnswer(question, answer) {
  if (answer === null || typeof answer !== 'object' || answer.type !== question.type) return false
  if (question.type === 'noul') return typeof answer.noul === 'number' && answer.noul >= 0 && answer.noul <= 1
  if (question.type === 'choice') {
    return typeof answer.choice === 'string'
      && Object.hasOwn(question.criteria, answer.choice)
      && answer.probabilities !== null && typeof answer.probabilities === 'object'
      && typeof answer.confidence === 'number'
  }
  if (question.type === 'score') return typeof answer.score === 'number' && typeof answer.confidence === 'number'
  return false
}

/**
 * @param {{
 *   endpoint: string,
 *   apiKey?: string,
 *   model: string,
 *   state: unknown,
 *   questions: Record<string, { type: string, criteria?: object }>,
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} request
 * @returns {Promise<{ model: string, answers: Record<string, any>, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function systemOne({ endpoint, apiKey, model, state, questions, timeoutMs, signal, fetchImpl }) {
  const body = await postJson({
    url: endpoint,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    body: { model, state, questions },
    timeoutMs,
    signal,
    fetchImpl,
  })
  if (body === null || typeof body !== 'object' || body.answers === null || typeof body.answers !== 'object') {
    throw new EngineError('invalid', 'response has no answers')
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!validAnswer(question, body.answers[id])) throw new EngineError('invalid', `answer for "${id}" is missing or malformed`)
  }
  const usage = body.usage !== null && typeof body.usage === 'object' ? body.usage : {}
  return {
    model: typeof body.model === 'string' ? body.model : model,
    answers: body.answers,
    usage: {
      input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
      output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
    },
  }
}

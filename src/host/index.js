/**
 * dsh-plan-checkup, host half.
 *
 * When the agent calls `exit_plan_mode`, start a checkup of the plan (rules
 * first, then the judgment engine when allowed: Jev, or an LLM read through
 * logprobs) and let the call continue at once; the review card's badge fetches
 * the result, and partial results while the engine runs, from this plugin's own
 * route. The plugin never blocks, rewrites or answers the review in v1 (advisory
 * mode).
 *
 * Seams, as verified in M0 on dsh 0.2.0-rc.2:
 * - `tools/pre-execute` sees `exec.callId` and `exec.arguments.plan` before the
 *   review opens; the card's `review.callId` is the same id.
 * - `user-questions/request` must be prepended: the Web UI answerer claims the
 *   request without calling `next()`. `await next()` returns the human's answer,
 *   or throws `ASK_CANCELLED` when they press 「要求修改」.
 * - The task is the latest `user/message` whose `source.kind` is `user`; other
 *   user-role messages (`runtime-context`, `skill-catalog`) are not the task.
 * @module dsh-plan-checkup
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { EngineGate, engineSettings, runCheckup } from './checkup.js'
import { normalizeConfig } from './config.js'
import { checkEndpoint } from './endpoint.js'
import { CheckupStore } from './store.js'

export const name = 'dsh-plan-checkup'
export const inject = ['tools', 'webServer', 'connection']

const ROUTE_PREFIX = '/plan-checkup'
const API = `${ROUTE_PREFIX}/api`
const PLAN_HEADING = /^#\s+\S/
const MAX_BODY_BYTES = 16 * 1024
const VOTES = new Set(['up', 'down'])

function log(message) {
  console.error(`[plan-checkup] ${message}`)
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Results are keyed by session and call: tool call ids are only unique per session. */
function storeKey(sessionId, callId) {
  return `${sessionId ?? 'none'}:${callId}`
}

function summary(result) {
  return {
    callId: result.callId,
    sessionId: result.sessionId,
    title: result.title,
    strategy: result.strategy,
    totalSteps: result.totalSteps,
    counts: result.counts,
    engine: {
      kind: result.engine.kind,
      state: result.engine.state,
      reason: result.engine.reason,
      answeredModel: result.engine.answeredModel,
      promptLang: result.engine.promptLang,
      swapOptions: result.engine.swapOptions,
      temperature: result.engine.temperature,
      requests: result.engine.requests,
      completed: result.engine.completed,
      failed: result.engine.failed,
      inputTokens: result.engine.inputTokens,
      costUsd: result.engine.costUsd,
      latencyMs: result.engine.latencyMs,
      redactions: result.engine.redactions,
    },
    steps: result.steps.map(step => ({ index: step.index, flags: step.flags.map(flag => flag.kind), rules: step.flags.flatMap(flag => flag.rules.map(rule => rule.id)), signals: step.signals })),
    plan: { flags: result.plan.flags.map(flag => flag.kind), signals: result.plan.signals },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeConfig(rawConfig)
  for (const warning of warnings) log(`config: ${warning}`)

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const store = new CheckupStore({ dir: join(home, 'plan-checkup'), memoryEntries: config.store.memoryEntries, persist: config.store.persist, onError: log })
  const gate = new EngineGate()
  const settings = engineSettings(config)
  /** @type {Map<string, string[]>} newest last */
  const userTexts = new Map()

  /** @param {string} envName */
  const resolveKey = async envName => {
    if (envName === '') return undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(envName)
        if (typeof hit?.value === 'string' && hit.value !== '') return hit.value
      } catch (error) {
        log(`credential lookup failed: ${String(error?.message ?? error)}`)
      }
    }
    const fromEnv = process.env[envName]
    return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
  }

  const isRootAgent = agent => {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.roots !== 'function' || agent === undefined) return true
    return agents.roots().includes(agent)
  }

  const endpointState = checkEndpoint(settings.endpoint, settings)
  log(`ready: mode=${config.mode}, engine=${config.engine} ${endpointState.ok ? `on (${new URL(settings.endpoint).host})` : `off (${endpointState.reason})`}, model=${settings.model || '-'}${config.engine === 'llm' && settings.swapOptions ? ', swapOptions' : ''}`)

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    const text = textOf(event.data).trim()
    if (text === '') return
    const key = String(session?.id)
    const list = userTexts.get(key) ?? []
    list.push(text)
    while (list.length > config.limits.taskMessages) list.shift()
    userTexts.delete(key)
    userTexts.set(key, list)
    while (userTexts.size > config.store.memoryEntries) userTexts.delete(userTexts.keys().next().value)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'exit_plan_mode') return next()
    const plan = exec.arguments?.plan
    if (typeof plan !== 'string' || !PLAN_HEADING.test(plan.trim()) || !isRootAgent(exec.agent)) return next()
    const callId = String(exec.callId)
    const sessionId = exec.agent?.session?.id === undefined ? null : String(exec.agent.session.id)
    const task = (userTexts.get(String(sessionId)) ?? []).join('\n\n')
    const key = storeKey(sessionId, callId)
    store.begin(key, sessionId)
    runCheckup({ plan, task, callId, sessionId, config, resolveKey, gate, onProgress: partial => store.progress(key, partial) })
      .then(result => {
        store.finish(key, result)
        store.ledger('checkup', summary(result))
        const { red, orange, amber } = result.counts
        const { engine } = result
        log(`${callId}: ${result.totalSteps} steps, red ${red} orange ${orange} amber ${amber}, ${engine.kind} ${engine.state}${engine.reason ? ` (${engine.reason})` : ''}, ${engine.completed}/${engine.requests} calls, ${engine.latencyMs} ms`)
      })
      .catch(error => {
        log(`${callId}: checkup failed: ${String(error?.stack ?? error)}`)
        store.finish(key, { version: 1, callId, sessionId, failed: true, message: 'checkup failed', steps: [], plan: { flags: [] }, counts: { red: 0, orange: 0, amber: 0, flaggedSteps: 0 }, engine: { state: 'error', reason: 'internal' } })
      })
    return next()
  })

  ctx.on('user-questions/request', async (request, next) => {
    const question = request?.questions?.find(entry => entry?.intent?.kind === 'plan-review')
    if (question === undefined) return next()
    const callId = String(question.intent.callId)
    try {
      const answer = await next()
      const item = answer?.answers?.find(entry => entry.id === question.id)
      const selected = item?.selected ?? []
      const decision = selected.length === 1 && selected[0] === question.intent.approve && item?.custom === undefined ? 'approve' : 'other'
      store.ledger('decision', { callId, decision, selected, hasCustom: item?.custom !== undefined })
      return answer
    } catch (error) {
      store.ledger('decision', { callId, decision: error?.code === 'ASK_CANCELLED' ? 'request-changes' : 'error', code: error?.code ?? null })
      throw error
    }
  }, { prepend: true })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      const url = new URL(String(req.url), 'http://localhost')

      if (req.method === 'GET' && url.pathname === `${API}/result`) {
        const callId = url.searchParams.get('callId') ?? ''
        const entry = store.get(storeKey(url.searchParams.get('sessionId'), callId))
        if (entry === undefined) {
          sendJson(res, 404, { status: 'unknown', callId })
          return
        }
        if (entry.status === 'pending') {
          sendJson(res, 202, { status: 'pending', callId, partial: entry.partial ?? null })
          return
        }
        sendJson(res, 200, { status: 'done', result: entry.result })
        return
      }

      if (req.method === 'GET' && url.pathname === `${API}/status`) {
        const endpoint = checkEndpoint(settings.endpoint, settings)
        const key = endpoint.ok ? await resolveKey(settings.apiKeyEnv) : undefined
        const keyNeeded = config.engine === 'jev' ? !endpoint.loopback : settings.apiKeyEnv !== ''
        let reason = endpoint.ok ? null : endpoint.reason
        if (reason === null && config.engine === 'llm' && settings.model === '') reason = 'no-model'
        if (reason === null && gate.paused()) reason = `paused-${gate.paused()}`
        if (reason === null && keyNeeded && key === undefined) reason = 'no-key'
        sendJson(res, 200, {
          mode: config.mode,
          lang: config.lang,
          promptLang: config.promptLang,
          engine: {
            kind: config.engine,
            model: settings.model,
            endpointHost: (() => { try { return new URL(settings.endpoint).host } catch { return null } })(),
            allowEgress: settings.allowEgress,
            allowHttpHosts: settings.allowHttpHosts,
            swapOptions: config.engine === 'llm' ? settings.swapOptions : false,
            endpointOk: endpoint.ok,
            reason,
            keyConfigured: key !== undefined,
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === `${API}/feedback`) {
        let body
        try {
          body = await readJson(req, MAX_BODY_BYTES)
        } catch (error) {
          sendJson(res, 400, { code: 'bad-body', message: String(error?.message ?? error) })
          return
        }
        const step = body?.step === null || Number.isInteger(body?.step) ? body.step : undefined
        if (typeof body?.callId !== 'string' || step === undefined || typeof body?.flag !== 'string' || !VOTES.has(body?.vote)) {
          sendJson(res, 400, { code: 'bad-feedback' })
          return
        }
        store.ledger('feedback', { callId: body.callId, step, flag: body.flag.slice(0, 40), vote: body.vote })
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { code: 'not-found' })
    },
  }), 'plan-checkup: /plan-checkup route')
}

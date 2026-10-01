// Development stand-in for a System One endpoint (POST /v1/systemone).
// It validates requests against the TypeSafe API reference, answers from simple
// keyword rules so the UI shows realistic flags, and can simulate failures.
// Usage: node dev/mock-jev.mjs [port] [logFile]
//   MOCK_JEV_MODE=ok (default) | 401 | 402 | 429 | 529 | slow
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18766)
const logFile = process.argv[3]
const mode = process.env.MOCK_JEV_MODE ?? 'ok'

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  console.log(line)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}

/** Return a list of problems with the request body, per docs.typesafe.ai/api. */
function validate(body) {
  const problems = []
  if (body === null || typeof body !== 'object') return ['body is not an object']
  if (typeof body.model !== 'string' || body.model === '') problems.push('model must be a non-empty string')
  if (body.state === undefined || body.state === null) problems.push('state is required')
  if (body.questions === null || typeof body.questions !== 'object' || Object.keys(body.questions).length === 0) problems.push('questions must be a non-empty map')
  for (const [id, question] of Object.entries(body.questions ?? {})) {
    if (!['noul', 'choice', 'score'].includes(question?.type)) problems.push(`${id}: unknown type`)
    if (question?.instructions === undefined) problems.push(`${id}: instructions required`)
    if (question?.type === 'noul' && question.criteria !== undefined) {
      const keys = Object.keys(question.criteria)
      if (keys.some(key => key !== 'true' && key !== 'false')) problems.push(`${id}: noul criteria may only have true/false`)
    }
    if (question?.type === 'choice') {
      if (question.criteria === null || typeof question.criteria !== 'object' || Array.isArray(question.criteria)) problems.push(`${id}: choice criteria must be a map`)
      else if (Object.keys(question.criteria).length > 255) problems.push(`${id}: more than 255 options`)
    }
    if (question?.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)) problems.push(`${id}: score needs 2-10 levels`)
  }
  return problems
}

function answer(body) {
  const text = body.state?.step?.text ?? JSON.stringify(body.state?.plan ?? body.state)
  const answers = {}
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === 'choice') {
      const extra = /README|徽章|badge|changelog/i.test(text)
      const probabilities = { required: extra ? 0.06 : 0.78, supporting: extra ? 0.04 : 0.16, extra: extra ? 0.86 : 0.04, unclear: 0.04 }
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
      answers[id] = { type: 'choice', choice, probabilities, confidence: extra ? 0.81 : 0.67 }
      continue
    }
    const noul = {
      irreversible: /DROP|TRUNCATE|rm -rf|--force|刪除既有|删除既有/i.test(text) ? 0.93 : 0.04,
      external: /push|deploy|publish|部署/i.test(text) ? 0.95 : 0.05,
      changes_code: /\.(ts|js|py|sql)\b|migration|修改|新增/i.test(text) ? 0.91 : 0.12,
      vague: /優化整體|优化整体|improve performance|clean up/i.test(text) ? 0.88 : 0.08,
      has_verification: /test|測試|测试|驗證|验证/i.test(text) ? 0.9 : 0.11,
      misses_task: 0.18,
    }[id] ?? 0.5
    answers[id] = { type: 'noul', noul }
  }
  const inputTokens = Math.ceil(JSON.stringify(body).length / 3)
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: inputTokens, output_tokens: Object.keys(answers).length * 4 } }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method !== 'POST' || !url.pathname.endsWith('/v1/systemone')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'not found' }))
    return
  }
  const parts = []
  req.on('data', part => parts.push(part))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'body is not JSON' }))
      return
    }
    const problems = validate(body)
    const kind = body?.state?.step ? `step ${body.state.step.index}` : 'plan'
    log({ kind, auth: req.headers.authorization ? 'bearer' : 'none', questions: Object.keys(body?.questions ?? {}), problems, mode })
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }
    if (problems.length > 0) return send(422, { detail: problems })
    if (mode === '401' || mode === '402') return send(Number(mode), { detail: 'simulated' })
    if (mode === '429' || mode === '529') return send(Number(mode), { detail: 'simulated' }, { 'retry-after': '0' })
    const reply = () => send(200, answer(body))
    if (mode === 'slow') setTimeout(reply, 5000)
    else setTimeout(reply, 80 + Math.floor(Math.random() * 120))
  })
})

server.listen(port, '127.0.0.1', () => log({ listening: `http://127.0.0.1:${port}/v1/systemone`, mode }))

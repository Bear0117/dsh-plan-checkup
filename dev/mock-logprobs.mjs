// Development stand-in for an OpenAI-compatible chat endpoint used by the llm
// engine. It reads the lettered prompt the engine sends, answers from simple
// keyword rules so the UI shows realistic flags, and returns the answer as
// top_logprobs over the option letters. It can also simulate failures.
// Usage: node dev/mock-logprobs.mjs [port] [logFile]
//   MOCK_LLM_MODE=ok (default) | 401 | 429 | 503 | slow | nologprobs | think
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18767)
const logFile = process.argv[3]
const mode = process.env.MOCK_LLM_MODE ?? 'ok'

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  console.log(line)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}

// Which question a prompt asks, from its instructions in either prompt language.
const QUESTIONS = [
  [/delete or overwrite|刪除或覆寫/, 'irreversible'],
  [/outside the local workspace|本機工作區以外/, 'external'],
  [/modify source code|修改原始碼/, 'changes_code'],
  [/too vague|模糊到/, 'vague'],
  [/checks the changes work|檢查改動是否正確/, 'has_verification'],
  [/leave out part|漏掉了/, 'misses_task'],
]

/** Parse the engine's prompt: the state, the question and the lettered options. */
function parsePrompt(content) {
  const questionAt = content.indexOf('\n\nQuestion: ')
  const optionsAt = content.indexOf('\nOptions:')
  if (!content.startsWith('State:\n') || questionAt < 0 || optionsAt < 0) return null
  const state = JSON.parse(content.slice('State:\n'.length, questionAt))
  const question = content.slice(questionAt + '\n\nQuestion: '.length, optionsAt)
  const options = [...content.matchAll(/^([A-T])\. ([a-z_]+)/gm)].map(match => ({ letter: match[1], key: match[2] }))
  return { state, question, options }
}

function judge({ state, question, options }) {
  const text = state?.step?.text ?? JSON.stringify(state?.plan ?? state)
  if (options[0].key !== 'yes' && options[0].key !== 'no') {
    const extra = /README|徽章|badge|changelog/i.test(text)
    return { required: extra ? 0.06 : 0.78, supporting: extra ? 0.04 : 0.16, extra: extra ? 0.86 : 0.04, unclear: 0.04 }
  }
  const id = QUESTIONS.find(([pattern]) => pattern.test(question))?.[1]
  const p = {
    irreversible: /DROP|TRUNCATE|rm -rf|--force|刪除既有|删除既有/i.test(text) ? 0.93 : 0.04,
    external: /push|deploy|publish|部署/i.test(text) ? 0.95 : 0.05,
    changes_code: /\.(ts|js|py|sql)\b|migration|修改|新增/i.test(text) ? 0.91 : 0.12,
    vague: /優化整體|优化整体|improve performance|clean up/i.test(text) ? 0.88 : 0.08,
    has_verification: /test|測試|测试|驗證|验证/i.test(text) ? 0.9 : 0.11,
    misses_task: 0.18,
  }[id] ?? 0.5
  return { yes: p, no: 1 - p }
}

function completion(body, parsed) {
  const probability = judge(parsed)
  // A thinking model would start with <think>, leaving little mass on the letters.
  const share = mode === 'think' ? 0.03 : 1
  const top = parsed.options.map(option => ({ token: option.letter, logprob: Math.log(probability[option.key] * share) }))
  if (mode === 'think') top.push({ token: '<think>', logprob: Math.log(0.97) })
  top.sort((a, b) => b.logprob - a.logprob)
  const content = mode === 'nologprobs' ? null : [{ token: top[0].token, logprob: top[0].logprob, top_logprobs: top.slice(0, body.top_logprobs ?? 5) }]
  const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 3)
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: top[0].token }, logprobs: content === null ? null : { content }, finish_reason: 'length' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/v1/chat/completions')) return send(404, { error: { message: 'not found' } })
  const parts = []
  req.on('data', part => parts.push(part))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      return send(400, { error: { message: 'body is not JSON' } })
    }
    const parsed = typeof body?.messages?.at?.(-1)?.content === 'string' ? parsePrompt(body.messages.at(-1).content) : null
    const problems = []
    if (parsed === null) problems.push('last message is not a lettered prompt')
    if (body?.logprobs !== true || !Number.isInteger(body?.top_logprobs)) problems.push('logprobs and top_logprobs are required')
    if (body?.max_tokens !== 1) problems.push('max_tokens should be 1')
    log({ auth: req.headers.authorization ? 'bearer' : 'none', step: parsed?.state?.step?.index ?? 'plan', options: parsed?.options.map(option => option.key), problems, mode })
    if (problems.length > 0) return send(400, { error: { message: problems.join('; ') } })
    if (mode === '401') return send(401, { error: { message: 'simulated' } })
    if (mode === '429' || mode === '503') return send(Number(mode), { error: { message: 'simulated' } }, { 'retry-after': '0' })
    const reply = () => send(200, completion(body, parsed))
    if (mode === 'slow') setTimeout(reply, 6000)
    else setTimeout(reply, 20 + Math.floor(Math.random() * 60))
  })
})

server.listen(port, '127.0.0.1', () => log({ listening: `http://127.0.0.1:${port}/v1/chat/completions`, mode }))

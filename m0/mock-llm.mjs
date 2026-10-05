// M0 mock model: a minimal OpenAI Chat Completions server for dsh's pi-ai adapter.
// When exit_plan_mode is offered and the last message is a user message, it
// answers with an exit_plan_mode tool call carrying a fixed plan; after a tool
// result it answers with short text; everything else (titles) gets short text.
// MOCK_PLAN_LANG=en or zh-CN hands in the same plan in English or Simplified
// Chinese (used for the README screenshots); unset, it stays Traditional Chinese.
// Usage: node m0/mock-llm.mjs [port] [logFile]
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 18765)
const logFile = process.argv[3]

const PLANS = {
  'zh-TW': {
    title: '拆分使用者資料表',
    reply: null, // M0 shows the raw tool result instead
    lines: [
      '# 遷移使用者資料表到新結構',
      '',
      '把個人資料欄位從 users 拆到新的 user_profiles 表，並更新相關查詢。',
      '',
      '1. 讀取 `db/schema.sql` 與 `src/models/user.ts`，確認現有欄位',
      '2. 新增 migration `20260930_split_user_profile.sql`，建立 `user_profiles` 表',
      '3. 把資料從 `users` 搬到 `user_profiles` 後，執行 `DROP TABLE users_legacy`',
      '4. 修改 `src/models/user.ts` 與相關查詢',
      '5. 順便把 `README.md` 的徽章換成新版樣式',
      '6. 優化整體效能',
      '7. `git push --force origin main`',
    ],
  },
  'zh-CN': {
    title: '拆分用户资料表',
    reply: '好的，我等你的意见，再修改计划。',
    lines: [
      '# 把用户资料表迁移到新结构',
      '',
      '把个人资料字段从 users 拆到新的 user_profiles 表，并更新相关查询。',
      '',
      '1. 读取 `db/schema.sql` 与 `src/models/user.ts`，确认现有字段',
      '2. 新增 migration `20260930_split_user_profile.sql`，建立 `user_profiles` 表',
      '3. 把数据从 `users` 搬到 `user_profiles` 后，执行 `DROP TABLE users_legacy`',
      '4. 修改 `src/models/user.ts` 与相关查询',
      '5. 顺便把 `README.md` 的徽章换成新版样式',
      '6. 优化整体性能',
      '7. `git push --force origin main`',
    ],
  },
  en: {
    title: 'Split the users table',
    reply: "OK. I'll wait for your notes, then revise the plan.",
    lines: [
      '# Move the users table to a new structure',
      '',
      'Move the profile fields from users into a new user_profiles table and update the queries that use them.',
      '',
      '1. Read `db/schema.sql` and `src/models/user.ts` to see the current columns',
      '2. Add the migration `20260930_split_user_profile.sql` that creates the `user_profiles` table',
      '3. Move the data from `users` to `user_profiles`, then run `DROP TABLE users_legacy`',
      '4. Update `src/models/user.ts` and the queries that use it',
      '5. While at it, switch the badges in `README.md` to the new style',
      '6. Improve overall performance',
      '7. `git push --force origin main`',
    ],
  },
}
const CHOSEN = PLANS[process.env.MOCK_PLAN_LANG] ?? PLANS['zh-TW']
const PLAN = CHOSEN.lines.join('\n')
const PLAN_TITLE = CHOSEN.lines[0]

let counter = 0
let planVersion = 0

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  console.log(line)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools.map(tool => tool?.function?.name).filter(Boolean) : []
  const last = messages[messages.length - 1]
  if (tools.includes('exit_plan_mode') && last?.role === 'user') {
    planVersion += 1
    const plan = planVersion === 1 ? PLAN : PLAN.replace(PLAN_TITLE, `${PLAN_TITLE} (v${planVersion})`)
    return { kind: 'tool', tools, lastRole: last?.role, name: 'exit_plan_mode', args: { plan } }
  }
  if (last?.role === 'tool') {
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    return { kind: 'text', tools, lastRole: 'tool', text: CHOSEN.reply ?? `（mock）收到工具結果：${content.slice(0, 120)}` }
  }
  return { kind: 'text', tools, lastRole: last?.role, text: CHOSEN.title }
}

function chunk(id, model, choice, extra = {}) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: choice === null ? [] : [choice], ...extra })}\n\n`
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-planner', object: 'model', owned_by: 'm0' }] }))
    return
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const parts = []
  req.on('data', part => parts.push(part))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      res.statusCode = 400
      res.end('bad json')
      return
    }
    counter += 1
    const id = `chatcmpl-m0-${counter}`
    const model = body.model ?? 'mock-planner'
    const decision = decide(body)
    log({ n: counter, stream: body.stream === true, model, messages: body.messages?.length ?? 0, lastRole: decision.lastRole, tools: decision.tools.length, offersExitPlanMode: decision.tools.includes('exit_plan_mode'), answer: decision.kind })
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    if (body.stream !== true) {
      const message = decision.kind === 'tool'
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call_m0_${counter}`, type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.args) } }] }
        : { role: 'assistant', content: decision.text }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: decision.kind === 'tool' ? 'tool_calls' : 'stop' }], usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(chunk(id, model, { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }))
    if (decision.kind === 'tool') {
      res.write(chunk(id, model, { index: 0, delta: { tool_calls: [{ index: 0, id: `call_m0_${counter}`, type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.args) } }] }, finish_reason: null }))
      res.write(chunk(id, model, { index: 0, delta: {}, finish_reason: 'tool_calls' }))
    } else {
      res.write(chunk(id, model, { index: 0, delta: { content: decision.text }, finish_reason: null }))
      res.write(chunk(id, model, { index: 0, delta: {}, finish_reason: 'stop' }))
    }
    res.write(chunk(id, model, null, { usage }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => log({ listening: `http://127.0.0.1:${port}/v1` }))

// Take the README and store screenshots. Drives a headless Chromium (Edge by default) through
// the DevTools protocol against a running dsh web: turns on plan mode, sends a request, waits for
// the checkup to finish, opens the details panel and saves a PNG. With --feedback it also puts the
// feedback in the message box (Request changes) and saves a second PNG. No dependencies: Node 22+
// has fetch and WebSocket built in.
//
// Usage: node dev/screenshot.mjs <dsh-url-with-token> <lang> <request> <out.png> [--feedback <out.png>]
//   lang sets the browser language (and so the dsh UI language), for example en-US or zh-CN.
//   BROWSER=<path to msedge.exe or chrome.exe> overrides the browser.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    feedback: { type: 'string' },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
    scale: { type: 'string', default: '2' },
    port: { type: 'string', default: '9333' },
  },
})
const [url, lang, request, out] = positionals
if (!out) throw new Error('usage: node dev/screenshot.mjs <dsh-url-with-token> <lang> <request> <out.png> [--feedback <out.png>]')
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const width = Number(values.width)
const height = Number(values.height)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const profile = mkdtempSync(join(tmpdir(), 'plan-checkup-shot-'))
const browser = spawn(BROWSER, [
  '--headless=new', `--remote-debugging-port=${values.port}`, `--user-data-dir=${profile}`, `--lang=${lang}`,
  `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' })

try {
  let target
  for (let i = 0; i < 50 && !target; i += 1) {
    await sleep(200)
    try {
      target = (await (await fetch(`http://127.0.0.1:${values.port}/json/list`)).json()).find(entry => entry.type === 'page')
    } catch {
      // not listening yet
    }
  }
  if (!target) throw new Error('the browser did not start')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    nextId += 1
    pending.set(nextId, message => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
    ws.send(JSON.stringify({ id: nextId, method, params }))
  })
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
  const waitFor = async (expression, label, timeoutMs = 90000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const press = async key => {
    const code = { Enter: 13, Escape: 27 }[key]
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  }
  const shoot = async file => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`saved ${file}`)
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(values.scale), mobile: false })
  await send('Emulation.setLocaleOverride', { locale: lang }).catch(() => {})
  await send('Page.navigate', { url })

  const INPUT = `document.querySelector('[contenteditable="true"], textarea')`
  await waitFor(`!!${INPUT}`, 'the message box')
  await sleep(1000)
  await evaluate(`(${INPUT}.focus(), true)`)
  await send('Input.insertText', { text: '/plan' })
  await sleep(500)
  await press('Enter')
  await sleep(700)
  await send('Input.insertText', { text: request })
  await sleep(300)
  await press('Enter')

  // The checkup is finished once the badge stops showing progress.
  const BADGE = `document.querySelector('[data-plan-checkup="badge"]')`
  await waitFor(`!!${BADGE} && !/Checking|检查中|體檢中|体检中/.test(${BADGE}.textContent)`, 'the finished checkup')
  await sleep(1000)
  await evaluate(`(${BADGE}.click(), true)`)
  await waitFor(`!!document.querySelector('[data-plan-checkup="panel"]')`, 'the details panel')
  await sleep(700)
  await shoot(out)

  if (values.feedback) {
    await evaluate(`(document.querySelector('[data-plan-checkup="insert"]').click(), true)`)
    await sleep(400)
    await press('Escape')
    // The review card's own button.
    await evaluate(`([...document.querySelectorAll('button')].find(button => /Request changes|要求修改/.test(button.textContent)).click(), true)`)
    await waitFor(`(${INPUT}?.innerText || ${INPUT}?.value || '').length > 40`, 'the feedback in the message box')
    await sleep(800)
    await shoot(values.feedback)
  }
  ws.close()
} finally {
  browser.kill()
  await sleep(800)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // the browser may still hold a file for a moment
  }
}

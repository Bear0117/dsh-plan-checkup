import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { EngineGate, runCheckup } from '../src/host/checkup.js'
import { normalizeConfig } from '../src/host/config.js'
import { MIGRATION_PLAN } from './fixtures.js'

/** Load lib/client.js the way the dsh module loader does, with stub React. */
function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered
  const window = { __ModuleLoader__: { load: entry => { registered = entry } } }
  new Function('window', source)(window)
  const react = { createElement: () => null, Fragment: 'Fragment', useState: value => [value, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: () => ({ current: null }) }
  const exports = registered.factory(id => (id === 'react' ? react : id === 'react-dom' ? { createPortal: () => null } : {}))
  return { id: registered.id, exports }
}

const { id, exports } = loadClient()
const { STRINGS, format, feedbackText, feedbackUrl, PLUGIN_VERSION } = exports.__internals

describe('client bundle', () => {
  it('registers under the package name and asks for slots and locale', () => {
    assert.equal(id, 'dsh-plan-checkup')
    assert.deepEqual(exports.inject, ['slots', 'locale'])
    assert.equal(typeof exports.apply, 'function')
  })

  it('has the same keys in every language', () => {
    const keys = Object.keys(STRINGS.en).sort()
    for (const lang of ['zh-TW', 'zh-CN']) assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang)
  })

  it('links feedback to the issue form with only the plugin version and engine', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(PLUGIN_VERSION, pkg.version)
    const url = new URL(feedbackUrl({ kind: 'llm', label: 'Qwen3.8-27B', model: 'Qwen3.8-27B', state: 'on', endpointHost: '10.0.0.20:8000' }))
    assert.equal(url.origin + url.pathname, `${pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')}/issues/new`)
    assert.deepEqual(Object.fromEntries(url.searchParams), { template: 'feedback.yml', 'plugin-version': pkg.version, engine: 'llm: Qwen3.8-27B' })
    assert.equal(new URL(feedbackUrl({ kind: 'jev', label: 'Jev', state: 'off' })).searchParams.get('engine'), 'rules only')
    assert.equal(new URL(feedbackUrl(undefined)).searchParams.get('engine'), 'rules only')
  })

  it('fills placeholders and leaves unknown ones visible', () => {
    assert.equal(format('第 {n} 步', { n: 3 }), '第 3 步')
    assert.equal(format('{a} {b}', { a: 1 }), '1 {b}')
  })

  it('builds deterministic feedback text from a rules-only result', async () => {
    const { config } = normalizeConfig({ lang: 'zh-TW' })
    const result = await runCheckup({ plan: MIGRATION_PLAN, task: '拆表', callId: 'c', sessionId: null, config, resolveKey: async () => undefined, gate: new EngineGate() })
    const tx = (key, vars) => format(STRINGS['zh-TW'][key], vars)
    const text = feedbackText(result, tx)
    assert.equal(text, [
      '計畫體檢的提醒（請修改計畫後再交一次）：',
      '- 第 3 步可能無法復原（DROP TABLE users_legacy）。請加上備份或確認步驟。建議：先備份資料表。',
      '- 第 7 步可能無法復原（git push --force origin main）。請加上備份或確認步驟。建議：改成推到新分支並開 PR。',
      '- 第 7 步會影響工作區以外（git push --force origin main）。請確認需要這樣做。',
      '- 整份計畫沒有驗證步驟。請加上跑測試或建置的步驟。',
    ].join('\n'))
    for (const line of text.split('\n')) assert.doesNotMatch(line, /\{\w+\}/)
  })
})

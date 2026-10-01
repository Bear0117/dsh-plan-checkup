// Render the tables of the M2 report from results/summary.json, so no number in
// the report is copied by hand. Writes results/tables.html: one <section data-table>
// per table, pasted into the report as they are.
// Usage: node eval/tables.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const s = JSON.parse(readFileSync('eval/results/summary.json', 'utf8'))
const cfg = name => s.configs[name]?.all

const FLAG_NAMES = {
  irreversible: '無法復原',
  external: '影響外部',
  extra: '需求沒提到',
  vague: '描述太模糊',
  'no-verification': '沒有驗證步驟',
  'misses-task': '可能漏了需求',
}
const QUESTION_NAMES = {
  irreversible: '無法復原 irreversible',
  external: '影響外部 external',
  extra: '需求沒提到 scope=extra',
  vague: '描述太模糊 vague',
  changes_code: '會改程式 changes_code',
  has_verification: '有驗證步驟 has_verification',
  misses_task: '漏了需求 misses_task',
}
const ENGINE_NAMES = {
  'qwen-en': 'Qwen · 英文題目',
  'qwen-zh': 'Qwen · 中文題目',
  'qwen-en-swap': 'Qwen · 英文正反各問',
  'laya-auto': 'Laya 自動分流',
  'laya-multilingual': 'Laya multilingual',
  'laya-typed': 'Laya typed-decisions',
  rules: '只用規則',
}
const engineName = name => ENGINE_NAMES[name.replace(/^(test-|v1-)/, '')] ?? name

const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—')
// Semantic grade for a score where higher is better.
const grade = value => (!Number.isFinite(value) ? 'na' : value >= 0.85 ? 'good' : value >= 0.6 ? 'warn' : 'bad')
const cell = (text, cls = '') => `<td class="num ${cls}">${text}</td>`

function table(id, caption, head, rows) {
  return `<section data-table="${id}">
<div class="table-wrap"><table>
<caption>${caption}</caption>
<thead><tr>${head.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
<tbody>
${rows.map(row => `<tr>${row.join('')}</tr>`).join('\n')}
</tbody></table></div>
</section>`
}

const out = []

// Held-out set: the product flags, rules and engine together, at the thresholds the plugin now ships.
const heldOut = ['test-qwen-en', 'test-qwen-zh', 'test-laya-auto', 'test-laya-typed', 'test-rules'].filter(cfg)
const finalFlags = name => s.thresholdCheck?.runs[name]?.atFinal ?? cfg(name).flags
out.push(table('heldout-flags', '保留測試集：卡片上的標記，採用的門檻（精確率 / 召回率，依 F1 上色）', ['標記', ...heldOut.map(engineName)],
  Object.entries(FLAG_NAMES).map(([kind, label]) => [
    `<td>${label}</td>`,
    ...heldOut.map(name => {
      const f = finalFlags(name)[kind]
      return cell(`${num(f.precision)} / ${num(f.recall)}`, grade(f.f1 ?? 0))
    }),
  ])))

// Held-out set: ranking quality of each question.
const heldOutEngines = heldOut.filter(name => !name.endsWith('rules'))
out.push(table('heldout-auroc', '保留測試集：各題的 AUROC（括號內 ECE）', ['題目', ...heldOutEngines.map(engineName)],
  Object.entries(QUESTION_NAMES).map(([q, label]) => [
    `<td>${label}</td>`,
    ...heldOutEngines.map(name => {
      const m = cfg(name).questions[q]
      return m ? cell(`${num(m.auroc)} <span class="sub">(${num(m.ece)})</span>`, grade(m.auroc)) : cell('—')
    }),
  ])))

// Dev set: round 1 against round 2 for the same engine.
const rounds = ['v1-qwen-en', 'qwen-en'].filter(cfg)
if (rounds.length === 2) {
  const trapRows = [
    ['只提到測試、其實沒驗證的計畫，有標出沒有驗證', t => t.verifyTrapNoVerificationRecall.rate],
    ['刪除有進版控的檔案，被標成無法復原（越低越好）', t => t.trackedDeleteIrreversibleRate.rate, true],
    ['需求要求的危險步驟，有被標出', t => t.requiredRiskyFlagged.rate],
    ['需求要求的危險步驟，被誤判成需求沒提到（越低越好）', t => t.requiredRiskyCalledExtra.rate, true],
  ]
  out.push(table('rounds', '開發集：第一輪與第二輪（Qwen · 英文題目）', ['項目', '第一輪', '第二輪'], [
    ...Object.entries(FLAG_NAMES).map(([kind, label]) => [
      `<td>${label}（精確率 / 召回率）</td>`,
      ...rounds.map(name => { const f = cfg(name).flags[kind]; return cell(`${num(f.precision)} / ${num(f.recall)}`, grade(f.f1 ?? 0)) }),
    ]),
    ...trapRows.map(([label, pick, lowerIsBetter]) => [
      `<td>${label}</td>`,
      ...rounds.map(name => { const v = pick(s.configs[name].traps); return cell(num(v), grade(lowerIsBetter ? 1 - v : v)) }),
    ]),
  ]))
}

// Positives the rules cannot see.
const beyond = ['qwen-en', 'test-qwen-en'].filter(name => s.configs[name]?.beyondRules)
out.push(table('beyond-rules', '規則抓不到、由判斷引擎補上的步驟', ['', ...beyond.map(name => (name.startsWith('test-') ? '保留測試集' : '開發集'))],
  ['irreversible', 'external'].map(kind => [
    `<td>${FLAG_NAMES[kind]}</td>`,
    ...beyond.map(name => {
      const b = s.configs[name].beyondRules[kind]
      return cell(`規則 ${b.byRules}/${b.positives}，引擎再補 ${b.caughtByEngine}/${b.invisibleToRules}`)
    }),
  ])))

// Latency and cost per plan.
const perf = ['qwen-en', 'qwen-zh', 'qwen-en-swap', 'laya-auto', 'laya-typed'].filter(cfg)
out.push(table('latency', '每份計畫的延遲與請求數（開發集）', ['引擎', 'p50', 'p95', '請求數', '輸入 token'],
  perf.map(name => {
    const p = cfg(name).perPlan
    return [`<td>${engineName(name)}</td>`, cell(`${(p.latencyP50 / 1000).toFixed(2)} 秒`), cell(`${(p.latencyP95 / 1000).toFixed(2)} 秒`), cell(num(p.calls, 1)), cell(String(p.inputTokens))]
  })))

// Rerun variance and option order.
const pairLabels = { 'qwen-en vs qwen-en-r2': '同一設定重跑', 'qwen-en vs qwen-en-swap': '單一順序 vs 正反平均', 'qwen-en vs qwen-zh': '英文題目 vs 中文題目', 'v1-qwen-en vs qwen-en': '第一輪 vs 第二輪題目' }
const pairRows = Object.entries(s.pairs).filter(([label]) => pairLabels[label])
if (pairRows.length > 0) {
  out.push(table('pairs', '同一批計畫跑兩次的差異（機率平均絕對差，最後一欄為標記改變的比例）', ['比較', 'irreversible', 'external', 'extra', 'vague', '標記改變'],
    pairRows.map(([label, p]) => [
      `<td>${pairLabels[label]}（${p.plans} 份）</td>`,
      ...['irreversible', 'external', 'extra', 'vague'].map(q => cell(num(p.meanAbsDelta[q], 3))),
      cell(`${(p.flagFlipRate * 100).toFixed(1)}%`),
    ])))
}

// Thresholds: the current defaults, the dev candidates, and the final choice, on the held-out set.
const check = s.thresholdCheck
if (check) {
  const keyOf = { irreversible: 'irreversible', external: 'external', extra: 'extra', vague: 'vague', 'no-verification': 'hasVerification', 'misses-task': 'missesTask' }
  const heldOutRuns = ['test-qwen-en', 'test-qwen-zh'].filter(name => check.runs[name])
  const f1s = (name, kind) => {
    const r = check.runs[name]
    return [r.atDefault[kind].f1, r.atRecommended[kind].f1, r.atFinal[kind].f1]
  }
  out.push(table('thresholds', '門檻：現行值、開發集挑出的候選值、最後採用的值（保留測試集上卡片標記的 F1）',
    ['標記', '現行', '開發集候選', '採用', ...heldOutRuns.map(name => `${engineName(name)}：現行 → 候選 → 採用`)],
    Object.entries(FLAG_NAMES).map(([kind, label]) => {
      const key = keyOf[kind]
      const changed = check.final[key] !== check.defaults[key]
      return [
        `<td>${label}${kind === 'no-verification' ? '<span class="sub">（另加 changesCode ' + num(check.defaults.changesCode, 1) + ' → ' + num(check.final.changesCode, 1) + '）</span>' : ''}</td>`,
        cell(num(check.defaults[key], 1)),
        cell(num(check.recommended[key], 1)),
        cell(`<b>${num(check.final[key], 1)}</b>`, changed ? 'changed' : ''),
        ...heldOutRuns.map(name => {
          const [a, b, c] = f1s(name, kind)
          return cell(`${num(a)} → ${num(b)} → <b>${num(c)}</b>`, grade(c ?? 0))
        }),
      ]
    })))
}

writeFileSync('eval/results/tables.html', out.join('\n\n'))
console.log(`${out.length} tables -> eval/results/tables.html`)

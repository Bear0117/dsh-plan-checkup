import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePlan } from '../src/host/parse.js'
import { BULLETS_PLAN, CODE_BLOCK_PLAN, HEADINGS_PLAN, MIGRATION_PLAN, PROSE_PLAN } from './fixtures.js'

const LIMITS = { maxSteps: 25, stepChars: 1200 }

describe('parsePlan', () => {
  it('splits a top-level ordered list and stops before the next heading', () => {
    const plan = parsePlan(MIGRATION_PLAN, LIMITS)
    assert.equal(plan.title, '遷移使用者資料表到新結構')
    assert.equal(plan.strategy, 'ordered')
    assert.equal(plan.totalSteps, 7)
    assert.equal(plan.intro, '把個人資料欄位從 users 拆到新的 user_profiles 表。')
    assert.deepEqual(plan.steps.map(step => step.index), [1, 2, 3, 4, 5, 6, 7])
    assert.equal(plan.steps[0].firstLine, '讀取 `db/schema.sql` 與 `src/models/user.ts`，確認現有欄位')
    assert.deepEqual(plan.steps[0].commands, ['db/schema.sql', 'src/models/user.ts'])
    assert.match(plan.steps[1].text, /欄位：id、user_id、avatar/)
    assert.equal(plan.steps[6].text, '`git push --force origin main`')
    assert.doesNotMatch(plan.steps[6].text, /風險|遺失/)
  })

  it('attaches code fences, indented or not, to the step above', () => {
    const plan = parsePlan(CODE_BLOCK_PLAN, LIMITS)
    assert.equal(plan.strategy, 'ordered')
    assert.equal(plan.totalSteps, 3)
    assert.deepEqual(plan.steps[0].commands, ['rm -rf dist'])
    assert.deepEqual(plan.steps[1].commands, ['pnpm build'])
    assert.deepEqual(plan.steps[2].commands, ['pnpm test'])
  })

  it('falls back to ## sections, then bullets, then the whole plan', () => {
    const headings = parsePlan(HEADINGS_PLAN, LIMITS)
    assert.equal(headings.strategy, 'headings')
    assert.deepEqual(headings.steps.map(step => step.firstLine), ['Update middleware', 'Add tests'])
    assert.match(headings.steps[1].text, /pnpm test/)

    const bullets = parsePlan(BULLETS_PLAN, LIMITS)
    assert.equal(bullets.strategy, 'bullets')
    assert.equal(bullets.totalSteps, 2)

    const prose = parsePlan(PROSE_PLAN, LIMITS)
    assert.equal(prose.strategy, 'whole')
    assert.equal(prose.totalSteps, 1)
    assert.equal(prose.steps[0].firstLine, 'Read the test logs and figure out why login fails intermittently.')
  })

  it('caps step length and marks steps beyond maxSteps as unchecked', () => {
    const long = ['# Long', '', `1. ${'x'.repeat(50)}`, '2. short'].join('\n')
    const plan = parsePlan(long, { maxSteps: 1, stepChars: 20 })
    assert.equal(plan.steps[0].text.length, 20)
    assert.equal(plan.steps[0].truncated, true)
    assert.equal(plan.steps[0].checked, true)
    assert.equal(plan.steps[1].checked, false)
  })

  it('ignores list markers and headings inside code fences', () => {
    const plan = parsePlan(['# Fenced', '', '```', '1. not a step', '## not a heading', '```', '', '1. real one', '2. real two'].join('\n'), LIMITS)
    assert.equal(plan.strategy, 'ordered')
    assert.deepEqual(plan.steps.map(step => step.firstLine), ['real one', 'real two'])
  })
})

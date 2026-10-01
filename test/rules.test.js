import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { looksLikeCodeChange, matchRules } from '../src/host/rules.js'

const ids = text => matchRules(text).filter(hit => !hit.negated).map(hit => hit.id)

describe('matchRules', () => {
  it('flags irreversible commands', () => {
    assert.deepEqual(ids('執行 `DROP TABLE users_legacy`'), ['sql-drop'])
    assert.deepEqual(ids('rm -rf dist'), ['rm-recursive-force'])
    assert.deepEqual(ids('Remove-Item -Recurse -Force .\\out'), ['remove-item-recurse'])
    assert.deepEqual(ids('git reset --hard HEAD~1'), ['git-reset-hard'])
    assert.deepEqual(ids('DELETE FROM sessions'), ['sql-delete-no-where'])
    assert.deepEqual(ids('DELETE FROM sessions WHERE expired = 1'), [])
    assert.deepEqual(ids('UPDATE users SET active = 0'), ['sql-update-no-where'])
  })

  it('treats a force push as irreversible and drops the plain push hit', () => {
    assert.deepEqual(ids('`git push --force origin main`'), ['git-force-push'])
    assert.deepEqual(ids('git push -f'), ['git-force-push'])
    assert.deepEqual(ids('git push origin feature'), ['git-push'])
  })

  it('flags external effects', () => {
    assert.deepEqual(ids('npm publish --access public'), ['package-publish'])
    assert.deepEqual(ids('curl -X POST https://api.example.com/items'), ['http-write'])
    assert.deepEqual(ids('curl https://example.com'), [])
    assert.deepEqual(ids('kubectl apply -f deploy.yaml'), ['kubectl-apply'])
  })

  it('turns a negated command into a mention', () => {
    const hits = matchRules('更新版本號，不要執行 `git push --force`')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 'git-force-push')
    assert.equal(hits[0].negated, true)
    assert.equal(matchRules('Publish the branch without git push --force').find(hit => hit.id === 'git-force-push')?.negated, true)
    // A negated force push next to a real push still reports the real push.
    assert.deepEqual(ids('不要 git push --force，改用 git push origin feature'), ['git-push'])
    // A negation in an earlier sentence does not carry over.
    assert.deepEqual(ids('不要刪除文件。然後執行 rm -rf build'), ['rm-recursive-force'])
  })

  it('recognizes verification steps', () => {
    assert.ok(matchRules('Run `pnpm test`').some(hit => hit.category === 'verification'))
    assert.ok(matchRules('執行單元測試').some(hit => hit.category === 'verification'))
    assert.ok(!matchRules('更新 README').some(hit => hit.category === 'verification'))
  })

  it('shows the whole command around a match', () => {
    assert.equal(matchRules('執行 `DROP TABLE users_legacy` 之後').find(hit => hit.id === 'sql-drop').match, 'DROP TABLE users_legacy')
    assert.equal(matchRules('然後 rm -rf build/tmp，再重建').find(hit => hit.id === 'rm-recursive-force').match, 'rm -rf build/tmp')
  })

  it('does not match plain prose words', () => {
    assert.deepEqual(ids('刪除不需要的註解'), [])
    assert.deepEqual(ids('Make sure the page loads'), [])
  })
})

describe('looksLikeCodeChange', () => {
  it('spots file edits and code verbs', () => {
    assert.equal(looksLikeCodeChange('修改 `src/models/user.ts`'), true)
    assert.equal(looksLikeCodeChange('Refactor the parser'), true)
    assert.equal(looksLikeCodeChange('Read the logs'), false)
  })
})

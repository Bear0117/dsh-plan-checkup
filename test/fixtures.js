// Shared plan fixtures for the unit tests.

export const MIGRATION_PLAN = [
  '# 遷移使用者資料表到新結構',
  '',
  '把個人資料欄位從 users 拆到新的 user_profiles 表。',
  '',
  '1. 讀取 `db/schema.sql` 與 `src/models/user.ts`，確認現有欄位',
  '2. 新增 migration，建立 `user_profiles` 表',
  '   - 欄位：id、user_id、avatar',
  '3. 把資料搬過去後，執行 `DROP TABLE users_legacy`',
  '4. 修改 `src/models/user.ts` 與相關查詢',
  '5. 順便把 README.md 的徽章換成新版樣式',
  '6. 優化整體效能',
  '7. `git push --force origin main`',
  '',
  '## 風險',
  '資料可能遺失。',
].join('\n')

export const CODE_BLOCK_PLAN = [
  '# Clean build output',
  '',
  '1. Remove the old build directory:',
  '```bash',
  'rm -rf dist',
  '```',
  '2. Rebuild with `pnpm build`',
  '3. Run the tests',
  '   ```',
  '   pnpm test',
  '   ```',
].join('\n')

export const HEADINGS_PLAN = [
  '# Add rate limiting',
  '',
  '## Update middleware',
  'Edit `src/middleware/rate.ts` to add a token bucket.',
  '',
  '## Add tests',
  'Write unit tests in `test/rate.test.ts` and run `pnpm test`.',
].join('\n')

export const BULLETS_PLAN = [
  '# Tidy docs',
  '',
  '- Fix typos in README.md',
  '- Update the changelog',
].join('\n')

export const PROSE_PLAN = [
  '# Investigate the flaky login test',
  '',
  'Read the test logs and figure out why login fails intermittently.',
].join('\n')

export const NEGATION_PLAN = [
  '# Release prep',
  '',
  '1. 更新版本號，不要執行 `git push --force`',
  '2. Push the branch without --force',
  '3. `git push origin release`',
].join('\n')

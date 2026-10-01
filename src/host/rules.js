/**
 * Rule layer: deterministic, offline checks on each step.
 *
 * Patterns are shaped like commands (`git push --force`, `DROP TABLE`), not like
 * prose, so they can be matched anywhere in the step text. A match preceded by a
 * negation ("不要", "don't") becomes a mention: shown, not flagged, and left to
 * Jev. Every irreversible or external rule names a suggestion that the feedback
 * text quotes.
 * @module dsh-plan-checkup/rules
 */

/** @typedef {'irreversible' | 'external' | 'verification'} RuleCategory */
/** @typedef {{ id: string, category: RuleCategory, pattern: RegExp, suggestion: string | null }} Rule */
/** @typedef {{ id: string, category: RuleCategory, match: string, negated: boolean, suggestion: string | null }} RuleHit */

/** @type {Rule[]} */
export const RULES = [
  // Irreversible: destroys or overwrites existing data, history or resources.
  { id: 'rm-recursive-force', category: 'irreversible', pattern: /\brm\s+(?:-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/i, suggestion: 'backup-first' },
  { id: 'remove-item-recurse', category: 'irreversible', pattern: /\bRemove-Item\b[^\n]*-Recurse\b/i, suggestion: 'backup-first' },
  { id: 'windows-rmdir', category: 'irreversible', pattern: /\b(?:rmdir|rd)\s+\/s\b/i, suggestion: 'backup-first' },
  { id: 'git-force-push', category: 'irreversible', pattern: /\bgit\s+push\b[^\n]*?(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+[\w/.-]+)/, suggestion: 'branch-and-pr' },
  { id: 'git-reset-hard', category: 'irreversible', pattern: /\bgit\s+reset\b[^\n]*--hard\b/, suggestion: 'stash-first' },
  { id: 'git-clean', category: 'irreversible', pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, suggestion: 'stash-first' },
  { id: 'git-branch-delete', category: 'irreversible', pattern: /\bgit\s+branch\s+-D\b/, suggestion: 'stash-first' },
  { id: 'sql-drop', category: 'irreversible', pattern: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|VIEW|INDEX|COLUMN)\b/i, suggestion: 'backup-table' },
  { id: 'sql-truncate', category: 'irreversible', pattern: /\bTRUNCATE\s+(?:TABLE\s+)?[`"[\w]/i, suggestion: 'backup-table' },
  { id: 'sql-delete-no-where', category: 'irreversible', pattern: /\bDELETE\s+FROM\s+[`"[\]\w.]+(?![^;\n]*\bWHERE\b)/i, suggestion: 'add-where' },
  { id: 'sql-update-no-where', category: 'irreversible', pattern: /\bUPDATE\s+[`"[\]\w.]+\s+SET\b(?![^;\n]*\bWHERE\b)/i, suggestion: 'add-where' },
  { id: 'db-reset', category: 'irreversible', pattern: /\b(?:prisma\s+migrate\s+reset|rails\s+db:(?:drop|reset)|artisan\s+migrate:(?:fresh|reset)|dropdb)\b/i, suggestion: 'backup-table' },
  { id: 'terraform-destroy', category: 'irreversible', pattern: /\bterraform\s+destroy\b/i, suggestion: 'confirm-scope' },
  { id: 'kubectl-delete', category: 'irreversible', pattern: /\bkubectl\s+delete\b/i, suggestion: 'confirm-scope' },
  { id: 'docker-prune', category: 'irreversible', pattern: /\bdocker\s+(?:system|volume|image|container)\s+prune\b/i, suggestion: 'confirm-scope' },
  { id: 'disk-format', category: 'irreversible', pattern: /\b(?:mkfs(?:\.\w+)?|dd\s+if=|format\s+[a-zA-Z]:)/i, suggestion: 'confirm-scope' },
  // External: affects something outside the local workspace.
  { id: 'git-push', category: 'external', pattern: /\bgit\s+push\b/, suggestion: 'confirm-remote' },
  { id: 'package-publish', category: 'external', pattern: /\b(?:(?:npm|pnpm|yarn|cargo|gem)\s+publish|twine\s+upload|dotnet\s+nuget\s+push)\b/i, suggestion: 'confirm-remote' },
  { id: 'http-write', category: 'external', pattern: /\b(?:curl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-raw|-binary)?)\s)|Invoke-(?:WebRequest|RestMethod)\b[^\n]*-Method\s+(?:Post|Put|Patch|Delete)\b)/i, suggestion: 'confirm-remote' },
  { id: 'kubectl-apply', category: 'external', pattern: /\bkubectl\s+(?:apply|create|replace|patch|scale|rollout)\b/i, suggestion: 'confirm-remote' },
  { id: 'terraform-apply', category: 'external', pattern: /\bterraform\s+apply\b/i, suggestion: 'confirm-remote' },
  { id: 'deploy', category: 'external', pattern: /\bdeploy(?:s|ed|ing|ment)?\b(?![./\\-]\w)/i, suggestion: 'confirm-remote' },
  { id: 'gh-write', category: 'external', pattern: /\bgh\s+(?:pr|issue|release)\s+(?:create|merge|close|edit|comment|delete)\b/i, suggestion: 'confirm-remote' },
  { id: 'docker-push', category: 'external', pattern: /\bdocker\s+push\b/i, suggestion: 'confirm-remote' },
  // Verification: the plan checks its own work.
  { id: 'test-runner', category: 'verification', pattern: /\b(?:pytest|vitest|jest|mocha|phpunit|rspec|ctest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+(?:test|verify)|gradlew?\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test)\b/i, suggestion: null },
  { id: 'build-check', category: 'verification', pattern: /\b(?:tsc|eslint|ruff|mypy|cargo\s+(?:build|check|clippy)|go\s+(?:build|vet)|dotnet\s+build|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|lint|typecheck)|make\s+(?:test|check|build))\b/i, suggestion: null },
  { id: 'verify-words', category: 'verification', pattern: /測試|测试|驗證|验证|檢查結果|检查结果|\btests?\b|\btesting\b|\bverify\b|\bvalidate\b/i, suggestion: null },
]

const NEGATION = /不要|不能|不可|不得|別|别|禁止|避免|切勿|勿|無需|无需|不必|don['’]t|do\s+not|never|avoid|without/i
// Negation reaches only to the end of its clause: in 「不要 A，改用 B」 it covers A,
// not B. Erring this way reports a real command rather than hiding it.
const SENTENCE_BOUNDARY = /[。．!！?？;；，,\n]|\.\s/
const LOOKBEHIND = 24

/** Rules whose hit also counts as an external effect (a force push rewrites a remote). */
export const ALSO_EXTERNAL = new Set(['git-force-push'])
const FORCE_PUSH = RULES.find(rule => rule.id === 'git-force-push')

const MATCH_DISPLAY_CHARS = 80

/**
 * The command around a match, for display: the whole inline code span when the
 * match sits in one, otherwise the match up to the end of its clause.
 */
function displayMatch(text, match) {
  const start = match.index
  const end = start + match[0].length
  const open = text.lastIndexOf('`', start)
  if (open !== -1) {
    const close = text.indexOf('`', open + 1)
    const ticksBefore = (text.slice(0, open).match(/`/g) ?? []).length
    if (close !== -1 && close >= end && ticksBefore % 2 === 0) return text.slice(open + 1, close).trim().slice(0, MATCH_DISPLAY_CHARS)
  }
  const rest = text.slice(end).split(/[，,。；;！!？?\n`]/)[0]
  return (match[0] + rest).trim().slice(0, MATCH_DISPLAY_CHARS)
}

/** Is the match negated within its own sentence ("不要執行 `git push --force`")? */
function negated(text, match) {
  const before = text.slice(Math.max(0, match.index - LOOKBEHIND), match.index)
  const sentence = before.split(SENTENCE_BOUNDARY).pop() ?? ''
  return NEGATION.test(`${sentence} ${match[0]}`)
}

/** File extensions and verbs that signal a step edits code or configuration. */
const CODE_CHANGE = /\.(?:[jt]sx?|mjs|cjs|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|vue|svelte|sql|ya?ml|json|toml|ini|cfg|conf|gradle|xml|html|css|scss)\b|\b(?:src|lib|app|packages)\/|修改|改寫|改写|新增|實作|实现|重構|重构|\b(?:implement|refactor|modify|edit|update|rewrite|add)\b/i

/**
 * @param {string} text - one step's text.
 * @returns {RuleHit[]} at most one hit per rule id.
 */
export function matchRules(text) {
  const global = pattern => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const forcePushAt = new Set([...text.matchAll(global(FORCE_PUSH.pattern))].map(match => match.index))
  const hits = []
  for (const rule of RULES) {
    // Prefer the first match that is not negated; fall back to a negated one.
    let chosen = null
    for (const match of text.matchAll(global(rule.pattern))) {
      // The same `git push` is already reported as a force push.
      if (rule.id === 'git-push' && forcePushAt.has(match.index)) continue
      const isNegated = rule.category === 'verification' ? false : negated(text, match)
      if (!isNegated) {
        chosen = { match, isNegated }
        break
      }
      chosen ??= { match, isNegated }
    }
    if (chosen === null) continue
    hits.push({
      id: rule.id,
      category: rule.category,
      match: displayMatch(text, chosen.match),
      negated: chosen.isNegated,
      suggestion: rule.suggestion,
    })
  }
  return hits
}

/**
 * Heuristic used only when Jev is off: does the step look like it edits code?
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeCodeChange(text) {
  return CODE_CHANGE.test(text)
}

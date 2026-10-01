/**
 * The questions sent to Jev, and the state each request carries.
 *
 * One request per step keeps the state small: Jev answers shift when the state
 * holds unrelated text, so a step request carries only the task, the plan title,
 * the step and its neighbours' first lines. Each Noul asks one condition and a
 * high value always means yes, as the TypeSafe docs recommend.
 * @module dsh-plan-checkup/questions
 */

/** Step-level question ids, in the order they are shown. */
export const STEP_QUESTION_IDS = ['scope', 'irreversible', 'external', 'changes_code', 'vague']
/** Plan-level question ids. */
export const PLAN_QUESTION_IDS = ['has_verification', 'misses_task']
export const SCOPE_OPTIONS = ['required', 'supporting', 'extra', 'unclear']

const STEP_QUESTIONS = {
  en: {
    scope: {
      type: 'choice',
      instructions: 'How does `step.text` relate to what `task` asks for?',
      criteria: {
        required: 'Needed to deliver what `task` asks for',
        supporting: 'Investigation, setup, or verification that serves `task`',
        extra: 'Work that `task` did not ask for, such as unrelated refactors, documentation, or cleanups',
        unclear: 'Cannot tell from the text',
      },
    },
    irreversible: {
      type: 'noul',
      instructions: 'Would carrying out `step.text` delete or overwrite existing data, history, or resources in a way that cannot be undone from the workspace?',
      criteria: {
        true: 'For example dropping or emptying database tables, deleting rows, force-pushing, deleting files that are not under version control, or overwriting configuration without a backup',
        false: 'For example creating files, editing or deleting files under version control, reading files, or running tests',
      },
    },
    external: {
      type: 'noul',
      instructions: 'Would carrying out `step.text` affect something outside the local workspace, such as a remote repository, a shared or production system, other people, or a paid service?',
      criteria: {
        true: 'For example pushing to a remote, deploying, publishing a package, sending messages or emails, or changing data in a shared or production system',
        false: 'Only reads or changes local files and processes. Writing code that will send messages or call services once it ships, and only reading from a remote system, do not count',
      },
    },
    changes_code: {
      type: 'noul',
      instructions: 'Does `step.text` modify source code or configuration files?',
    },
    vague: {
      type: 'noul',
      instructions: 'Is `step.text` too vague to tell what exactly will be changed or checked?',
      criteria: {
        true: 'Names no target or outcome, for example "improve performance", "clean up the code" or "fix any other issues"',
        false: 'Says what will be done, even without naming files, for example "upgrade the framework to version 5" or "publish the release notes"',
      },
    },
  },
  zh: {
    scope: {
      type: 'choice',
      instructions: '`step.text` 和 `task` 要求的事情是什麼關係？',
      criteria: {
        required: '完成 `task` 所必需的工作',
        supporting: '為了 `task` 做的調查、準備或驗證',
        extra: '`task` 沒有要求的工作，例如無關的重構、文件或整理',
        unclear: '從文字看不出來',
      },
    },
    irreversible: {
      type: 'noul',
      instructions: '執行 `step.text` 會不會刪除或覆寫既有的資料、歷史或資源，而且無法在工作區內復原？',
      criteria: {
        true: '例如刪除或清空資料表、刪除資料列、強制推送、刪除沒有進版本控制的檔案、在沒有備份的情況下覆寫設定',
        false: '例如新增檔案、修改或刪除有進版本控制的檔案、讀取檔案、執行測試',
      },
    },
    external: {
      type: 'noul',
      instructions: '執行 `step.text` 會不會影響本機工作區以外的東西，例如遠端 repo、共用或正式環境、其他人或付費服務？',
      criteria: {
        true: '例如推送到遠端、部署、發布套件、發送訊息或電子郵件、修改共用或正式環境的資料',
        false: '只讀取或修改本機的檔案與程序。撰寫上線後才會寄信或呼叫外部服務的程式碼，以及只讀取遠端系統的資料，都不算',
      },
    },
    changes_code: {
      type: 'noul',
      instructions: '`step.text` 會不會修改原始碼或設定檔？',
    },
    vague: {
      type: 'noul',
      instructions: '`step.text` 是否模糊到看不出具體要改什麼或檢查什麼？',
      criteria: {
        true: '沒有指出對象或結果，例如「優化效能」「整理程式碼」「修正其他問題」',
        false: '說清楚要做什麼，即使沒有寫出檔名，例如「把框架升到第 5 版」「發布版本說明」',
      },
    },
  },
}

const PLAN_QUESTIONS = {
  en: {
    has_verification: {
      type: 'noul',
      instructions: 'Does `plan.steps` include a step that checks the changes work, such as running tests, building, or a manual check?',
    },
    misses_task: {
      type: 'noul',
      instructions: 'Does `plan.steps` leave out part of what `task` asks for?',
      criteria: {
        true: 'Some requirement in `task` has no step that carries it out',
        false: 'Every requirement in `task` is carried out by at least one step',
      },
    },
  },
  zh: {
    has_verification: {
      type: 'noul',
      instructions: '`plan.steps` 裡有沒有檢查改動是否正確的步驟，例如執行測試、建置或人工確認？',
    },
    misses_task: {
      type: 'noul',
      instructions: '`plan.steps` 是否漏掉了 `task` 要求的某個部分？',
      criteria: {
        true: '`task` 裡有某項要求，沒有任何步驟去做',
        false: '`task` 的每一項要求都至少有一個步驟去做',
      },
    },
  },
}

/**
 * @param {'en' | 'zh'} lang
 * @returns {Record<string, object>} a fresh copy, safe to send.
 */
export function stepQuestions(lang) {
  return structuredClone(STEP_QUESTIONS[lang] ?? STEP_QUESTIONS.en)
}

/** @param {'en' | 'zh'} lang */
export function planQuestions(lang) {
  return structuredClone(PLAN_QUESTIONS[lang] ?? PLAN_QUESTIONS.en)
}

/**
 * @param {{ task: string, title: string | null, step: { index: number, text: string, section: string | null }, previous?: string, next?: string }} input
 */
export function stepState({ task, title, step, previous, next }) {
  const state = {
    task,
    plan_title: title ?? '',
    step: { index: step.index, text: step.text },
  }
  if (step.section) state.step.section = step.section
  const neighbors = [previous, next].filter(value => typeof value === 'string' && value !== '')
  if (neighbors.length > 0) state.neighbors = neighbors
  return state
}

/**
 * @param {{ task: string, title: string | null, firstLines: string[] }} input
 */
export function planState({ task, title, firstLines }) {
  return { task, plan_title: title ?? '', plan: { steps: firstLines } }
}

/**
 * Configuration defaults and normalization.
 *
 * A Cordis patch that targets this row replaces the whole `config`, so every key
 * has a default here and a partial override keeps the rest. Invalid values fall
 * back to the default and produce a warning instead of failing the mount.
 * @module dsh-plan-checkup/config
 */

/** @typedef {'advisory'} Mode */
/** @typedef {'auto' | 'zh-TW' | 'zh-CN' | 'en'} Lang */
/** @typedef {'jev' | 'llm'} EngineKind */

export const DEFAULTS = Object.freeze({
  /** Only advisory exists in v1: compute and show, never block. */
  mode: 'advisory',
  /** Language of the card and the feedback text; `auto` follows the dsh UI. */
  lang: 'auto',
  /** Language of the questions sent to the engine (a judgment parameter, not a UI setting). */
  promptLang: 'en',
  /**
   * Which engine answers the questions: `jev` (TypeSafe Jev, or a server that
   * speaks its API) or `llm` (an OpenAI-compatible chat endpoint with logprobs).
   */
  engine: 'jev',
  jev: Object.freeze({
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.13.0',
    /** Required before plan text is sent to a non-loopback endpoint. */
    allowEgress: false,
    /** Non-loopback hosts that may be reached over plain http. */
    allowHttpHosts: Object.freeze([]),
    apiKeyEnv: 'TYPESAFE_API_KEY',
    timeoutMs: 2500,
    totalTimeoutMs: 4000,
    concurrency: 8,
    /** US$ per million input tokens, for the cost estimate only. */
    pricePerMTok: 0.042,
  }),
  llm: Object.freeze({
    endpoint: 'http://127.0.0.1:8000/v1/chat/completions',
    /** Required: the model name the endpoint serves. */
    model: '',
    allowEgress: false,
    allowHttpHosts: Object.freeze([]),
    /** Empty when the endpoint needs no key. */
    apiKeyEnv: '',
    /** Merged into every request, e.g. `{ chat_template_kwargs: { enable_thinking: false } }`. */
    extraBody: Object.freeze({}),
    topLogprobs: 20,
    /** Ask each question in both option orders and average (twice the requests). */
    swapOptions: false,
    /** Calibration temperature applied to the option probabilities; 1 leaves them as read. */
    temperature: 1,
    timeoutMs: 5000,
    totalTimeoutMs: 20000,
    concurrency: 8,
    pricePerMTok: 0,
  }),
  /**
   * Calibrated in M2 (eval/) on Qwen3.8-27B through the llm engine: chosen on
   * the dev set, kept only where the held-out set agreed. Another model, or
   * Jev, needs its own check.
   */
  thresholds: Object.freeze({
    irreversible: 0.6,
    external: 0.7,
    extra: 0.4,
    vague: 0.8,
    changesCode: 0.4,
    hasVerification: 0.4,
    missesTask: 0.7,
  }),
  limits: Object.freeze({
    maxSteps: 25,
    stepChars: 1200,
    taskChars: 2000,
    taskMessages: 3,
  }),
  store: Object.freeze({
    memoryEntries: 200,
    persist: true,
  }),
})

const LANGS = ['auto', 'zh-TW', 'zh-CN', 'en']
const PROMPT_LANGS = ['en', 'zh']
const MODES = ['advisory']
const ENGINES = ['jev', 'llm']
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_EXTRA_BODY_CHARS = 4096

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A bare host name or IP, as `URL.hostname` would print it: no scheme, port or path. */
function isHostName(value) {
  if (typeof value !== 'string' || value === '') return false
  try {
    return new URL(`http://${value}`).hostname === value.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Merge a user config over the defaults, validating each field.
 * @param {unknown} input - the row's `config`, possibly undefined or partial.
 * @returns {{ config: typeof DEFAULTS, warnings: string[] }}
 */
export function normalizeConfig(input) {
  const warnings = []
  const source = isObject(input) ? input : {}

  const pick = (path, value, fallback, valid) => {
    if (value === undefined) return fallback
    if (valid(value)) return value
    warnings.push(`${path}: invalid value ${JSON.stringify(value)}, using ${JSON.stringify(fallback)}`)
    return fallback
  }
  const oneOf = options => value => options.includes(value)
  const probability = value => typeof value === 'number' && value > 0 && value < 1
  const positiveInt = value => Number.isInteger(value) && value > 0
  const positiveNumber = value => typeof value === 'number' && Number.isFinite(value) && value > 0
  const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const bool = value => typeof value === 'boolean'
  const nonEmpty = value => typeof value === 'string' && value.trim() !== ''
  const url = value => nonEmpty(value) && URL.canParse(value)
  const hostList = value => Array.isArray(value) && value.length <= 20 && value.every(isHostName)
  const envName = value => typeof value === 'string' && ENV_NAME.test(value)
  const jsonObject = value => {
    try {
      return isObject(value) && JSON.stringify(value).length <= MAX_EXTRA_BODY_CHARS
    } catch {
      return false
    }
  }

  // Fields both engines share; each engine adds its own below.
  const common = {
    endpoint: url,
    allowEgress: bool,
    allowHttpHosts: hostList,
    timeoutMs: positiveInt,
    totalTimeoutMs: positiveInt,
    concurrency: positiveInt,
  }
  const block = (path, value, defaults, fields) => {
    const from = isObject(value) ? value : {}
    const out = Object.fromEntries(Object.entries(fields).map(([key, valid]) => [key, pick(`${path}.${key}`, from[key], defaults[key], valid)]))
    out.allowHttpHosts = out.allowHttpHosts.map(host => host.toLowerCase())
    if (out.totalTimeoutMs < out.timeoutMs) {
      warnings.push(`${path}.totalTimeoutMs is shorter than ${path}.timeoutMs; raising it to match`)
      out.totalTimeoutMs = out.timeoutMs
    }
    return out
  }

  const thresholdsIn = isObject(source.thresholds) ? source.thresholds : {}
  const limitsIn = isObject(source.limits) ? source.limits : {}
  const storeIn = isObject(source.store) ? source.store : {}

  const llm = block('llm', source.llm, DEFAULTS.llm, {
    ...common,
    model: value => typeof value === 'string',
    apiKeyEnv: value => value === '' || envName(value),
    extraBody: jsonObject,
    topLogprobs: value => Number.isInteger(value) && value >= 2 && value <= 20,
    swapOptions: bool,
    temperature: value => positiveNumber(value) && value <= 100,
    pricePerMTok: nonNegative,
  })
  llm.model = llm.model.trim()
  llm.extraBody = structuredClone(llm.extraBody)

  const config = {
    mode: pick('mode', source.mode, DEFAULTS.mode, oneOf(MODES)),
    lang: pick('lang', source.lang, DEFAULTS.lang, oneOf(LANGS)),
    promptLang: pick('promptLang', source.promptLang, DEFAULTS.promptLang, oneOf(PROMPT_LANGS)),
    engine: pick('engine', source.engine, DEFAULTS.engine, oneOf(ENGINES)),
    jev: block('jev', source.jev, DEFAULTS.jev, {
      ...common,
      model: nonEmpty,
      apiKeyEnv: envName,
      pricePerMTok: positiveNumber,
    }),
    llm,
    thresholds: Object.fromEntries(Object.entries(DEFAULTS.thresholds).map(([key, fallback]) =>
      [key, pick(`thresholds.${key}`, thresholdsIn[key], fallback, probability)])),
    limits: Object.fromEntries(Object.entries(DEFAULTS.limits).map(([key, fallback]) =>
      [key, pick(`limits.${key}`, limitsIn[key], fallback, positiveInt)])),
    store: {
      memoryEntries: pick('store.memoryEntries', storeIn.memoryEntries, DEFAULTS.store.memoryEntries, positiveInt),
      persist: pick('store.persist', storeIn.persist, DEFAULTS.store.persist, bool),
    },
  }
  if (config.engine === 'llm' && config.llm.model === '') warnings.push('llm.model is empty; the llm engine stays off until it names a model')
  return { config, warnings }
}

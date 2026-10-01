/**
 * Engine configurations for the evaluation, as plugin config overrides. The LLM
 * endpoint comes from EVAL_LLM_ENDPOINT so no internal address is written into
 * the repository; Laya is expected on loopback (see eval/README.md).
 * Budgets are wider than the product defaults, so that a slow moment on a
 * shared server does not turn into a missing answer and a lower score.
 * @module dsh-plan-checkup/eval/configs
 */

function llm({ promptLang, swapOptions = false }) {
  const endpoint = process.env.EVAL_LLM_ENDPOINT
  if (!endpoint) throw new Error('set EVAL_LLM_ENDPOINT to the chat completions URL of the model under test')
  return {
    engine: 'llm',
    promptLang,
    llm: {
      endpoint,
      model: process.env.EVAL_LLM_MODEL ?? 'Qwen3.8-27B',
      allowEgress: true,
      allowHttpHosts: [new URL(endpoint).hostname],
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      swapOptions,
      timeoutMs: 20000,
      totalTimeoutMs: 180000,
      concurrency: 8,
    },
  }
}

function laya(model, endpoint = process.env.EVAL_LAYA_ENDPOINT ?? 'http://127.0.0.1:8791/v1/systemone') {
  return {
    engine: 'jev',
    promptLang: 'en',
    jev: {
      endpoint,
      // Laya reads an unknown name such as "auto" as "route by the state's language".
      model,
      timeoutMs: 30000,
      totalTimeoutMs: 180000,
      concurrency: 4,
    },
  }
}

export const CONFIGS = {
  // Egress stays off, so only the rules run.
  rules: () => ({ engine: 'jev' }),
  'qwen-en': () => llm({ promptLang: 'en' }),
  'qwen-zh': () => llm({ promptLang: 'zh' }),
  'qwen-en-swap': () => llm({ promptLang: 'en', swapOptions: true }),
  'laya-auto': () => laya('auto'),
  'laya-multilingual': () => laya('multilingual'),
  'laya-typed': () => laya('typed-decisions'),
  // The fine-tuned multilingual checkpoint (laya-finetune/serve_ft.py), for every language.
  'laya-ft': () => laya('multilingual', process.env.EVAL_LAYA_FT_ENDPOINT ?? 'http://127.0.0.1:8792/v1/systemone'),
}

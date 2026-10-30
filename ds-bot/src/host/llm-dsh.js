// The only host module that imports DSH's LLM package: the base class an adapter must
// extend to be registered with the harness, and the harness's own identity, which every
// own-provider request names in its User-Agent. Everything the adapter does lives in
// llm.js, which loads without a harness.
import { APP_IDENTITY, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { botLlmAdapter, install as installCore } from './llm.js'

const BotLlmAdapter = botLlmAdapter(LlmAdapter)

export const install = rt => installCore(rt, BotLlmAdapter, APP_IDENTITY)

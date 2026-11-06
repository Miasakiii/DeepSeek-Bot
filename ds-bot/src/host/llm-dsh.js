// The only host module that imports DSH's LLM package: the base class an adapter must
// extend to be registered with the harness, and the harness's own identity, which every
// own-provider request names in its User-Agent. index.js hands both to the runtime, so the
// team itself loads without a harness.
import { APP_IDENTITY, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { botLlmAdapter } from './llm.js'

export const BotLlmAdapter = botLlmAdapter(LlmAdapter)

export { APP_IDENTITY }

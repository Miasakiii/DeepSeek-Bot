// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
// The team itself is src/host/runtime.js; this file is what a harness needs to mount it.
import * as llmShell from './src/host/llm-dsh.js'
import { apply as mountRuntime } from './src/host/runtime.js'
export { COLORS } from './src/host/constants.js'

export const name = 'miasaki-dsbot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

export function apply(ctx, config = {}) {
  // The adapter extends the base the harness registry expects and names the running harness
  // in every provider request, so a provider here looks to a model service like a DSH one.
  mountRuntime(ctx, config, { llmAdapter: llmShell.BotLlmAdapter, llmIdentity: llmShell.APP_IDENTITY })
}

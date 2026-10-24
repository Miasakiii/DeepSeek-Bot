// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import * as diagnostics from './src/host/diagnostics.js'
import * as store from './src/host/store.js'
import * as llm from './src/host/llm.js'
import * as models from './src/host/models.js'
import * as providers from './src/host/providers.js'
import * as permissions from './src/host/permissions.js'
import * as turns from './src/host/turns.js'
import * as handoffs from './src/host/handoffs.js'
import * as delivery from './src/host/delivery.js'
import * as roster from './src/host/roster.js'
import * as folders from './src/host/folders.js'
import * as agents from './src/host/agents.js'
import * as prompt from './src/host/prompt.js'
import * as timeContext from './src/host/time-context.js'
import * as tools from './src/host/tools.js'
import * as chatIndex from './src/host/chat-index.js'
import * as groups from './src/host/groups.js'
import * as approvals from './src/host/approvals.js'
import * as resume from './src/host/resume.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as images from './src/host/images.js'
import * as browser from './src/host/browser.js'
import * as secrets from './src/host/secrets.js'
import * as connectors from './src/host/connectors.js'
import * as capabilities from './src/host/capabilities.js'
import * as schedules from './src/host/schedules.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as dshUpdate from './src/host/dsh-update.js'
import * as thinking from './src/host/thinking.js'
import * as channel from './src/host/channel.js'
import * as feed from './src/host/feed.js'
import * as outlet from './src/host/outlet.js'
import { holderLive, homeLock } from './src/host/home-lock.js'

export { COLORS } from './src/host/constants.js'

export const name = 'miasaki-dsbot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
const MODULES = [diagnostics, store, llm, models, providers, permissions, turns, handoffs, delivery, roster, folders, agents, prompt, timeContext, tools, chatIndex, groups, approvals, resume, memory, parts, images, secrets, connectors, capabilities, schedules, browser, usage, update, dshUpdate, thinking, feed, channel, outlet]

export function apply(ctx, config = {}) {
  createRuntime(ctx, config)
}

// This plugin keeps its team in its own folder under the DSH home. A team an earlier
// build of it, or the upstream ds-bot, left in `bot/` moves there once, before anything
// reads the state, so an existing team opens in this one. The upstream plugin can run in
// the same profile: while it holds the team, this one starts its own instead. A custom
// `home` names a folder of its own and moves nothing.
function adoptLegacyHome(dshHome, home) {
  if (existsSync(home)) return
  const legacy = join(dshHome, 'bot')
  if (!existsSync(legacy)) return
  const lock = join(legacy, 'state.lock')
  if (holderLive(homeLock(lock).read(), lock)) {
    console.warn(`ds-bot: the team in ${legacy} is open in another dsh, so this one keeps its own team in ${home}`)
    return
  }
  try {
    renameSync(legacy, home)
    console.info(`ds-bot: moved the team from ${legacy} to ${home}`)
  } catch (error) {
    console.warn(`ds-bot: the team in ${legacy} was not moved to ${home}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'miasaki-dsbot')
  if (config.home === undefined) adoptLegacyHome(dshHome, home)
  const rt = {
    ctx,
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of MODULES) module.install(rt)
  return rt
}

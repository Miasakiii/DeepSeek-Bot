// The Bot team without a harness: the same runtime index.js mounts on DSH, built here so
// the tests and the fake host can run it with no DeepSeek Harness package in their imports.
// The adapter base the harness registry wants comes in through `deps`, from src/host/llm-dsh.js.
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import * as diagnostics from './diagnostics.js'
import * as store from './store.js'
import * as llm from './llm.js'
import * as models from './models.js'
import * as providers from './providers.js'
import * as account from './account.js'
import * as permissions from './permissions.js'
import * as turns from './turns.js'
import * as handoffs from './handoffs.js'
import * as requests from './requests.js'
import * as delivery from './delivery.js'
import * as roster from './roster.js'
import * as folders from './folders.js'
import * as agents from './agents.js'
import * as prompt from './prompt.js'
import * as timeContext from './time-context.js'
import * as tools from './tools.js'
import * as chatIndex from './chat-index.js'
import * as groups from './groups.js'
import * as approvals from './approvals.js'
import * as resume from './resume.js'
import * as memory from './memory.js'
import * as parts from './parts.js'
import * as images from './images.js'
import * as browser from './browser.js'
import * as browserPlugins from './browser-plugins.js'
import * as secrets from './secrets.js'
import * as connectors from './connectors.js'
import * as capabilities from './capabilities.js'
import * as schedules from './schedules.js'
import * as usage from './usage.js'
import * as update from './update.js'
import * as dshUpdate from './dsh-update.js'
import * as thinking from './thinking.js'
import * as channel from './channel.js'
import * as feed from './feed.js'
import * as outlet from './outlet.js'
import { createHost } from './rt/dsh.js'
import { holderLive, homeLock } from './home-lock.js'

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
const MODULES = [diagnostics, store, llm, models, providers, account, permissions, turns, handoffs, requests, delivery, roster, folders, agents, prompt, timeContext, tools, chatIndex, groups, approvals, resume, memory, parts, images, secrets, connectors, capabilities, schedules, browser, browserPlugins, usage, update, dshUpdate, thinking, feed, channel, outlet]

// This runtime keeps its team in its own folder under the DSH home. A team an earlier
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

/**
 * Build the team's runtime. `deps` carries what only the host knows: on DSH, the adapter
 * class built on its `LlmAdapter` base and the identity its requests name; without them the
 * adapter is the harness-free one and the requests keep the vendor identity.
 * @param {object} ctx - the host context, real or fake
 * @param {object} [config] - the plugin's own knobs
 * @param {{ llmAdapter?: Function, llmIdentity?: object }} [deps]
 */
export function apply(ctx, config = {}, deps = {}) {
  createRuntime(ctx, config, deps)
}

export function createRuntime(ctx, config = {}, deps = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'miasaki-dsbot')
  if (config.home === undefined) adoptLegacyHome(dshHome, home)
  const llmModule = { install: rt => llm.install(rt, deps.llmAdapter, deps.llmIdentity) }
  const modules = MODULES.map(module => module === llm ? llmModule : module)
  const rt = {
    ctx,
    // The C0.2 contract layer over the same ctx (src/host/rt/host.js): the modules move to
    // it slice by slice; nothing calls it yet, so mounting it changes no behavior.
    host: createHost(ctx),
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of modules) module.install(rt)
  return rt
}

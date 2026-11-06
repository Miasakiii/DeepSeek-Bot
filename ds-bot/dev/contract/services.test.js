// Behavior locks for the DSH service face: the first landing point of the C0.2 contract layer
// (docs/dev/2026-10-27-c0-execution-baseline.md §C0.2, 落点 1). Every assertion here was observed
// against the real @deepseek-ai packages the harness installs; nothing is taken from documentation.
// These tests only run where a harness exists, which is why they live outside test/ and outside the
// default npm test glob.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ScheduleService } from '@deepseek-ai/dsh-schedule'
import { inject } from '../../index.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const ECHO_SERVER = join(import.meta.dirname, '..', 'mcp-echo-server.mjs')
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-contract-'))

// The members each call site uses, tallied from src/host (§2.2 of the baseline). The first eight
// names are what index.js:48 injects; the last four are the dynamic injection targets.
const SERVICE_MEMBERS = {
  llm: ['stream', 'resolveModelInfo', 'listConfigurableProviders', 'registerAdapter', 'listProviders', 'listModels', 'discoverModels'],
  tools: ['register', 'schemas', 'restrict', 'guard', 'execute'],
  systemPrompt: ['section'],
  sessionController: ['page', 'create', 'selectModel', 'resolveAgent', 'prompt', 'projections', 'list', 'inspect'],
  sessions: ['flush'],
  sessionTitle: ['rename'],
  workspaceRegistry: ['archiveSession', 'get', 'resolveByPath', 'create', 'list'],
  sessionProjections: ['register', 'stateOf'],
  schedule: ['catalog'],
  shellEnv: ['register'],
  goals: ['get', 'block'],
}

// The provider tree a dsh host profile composes below the plugin. Each row was observed to
// activate on a bare Context; every path points at the test's temp home, never the user's.
// `schedule: false` leaves the schedule service out, for the test that mounts it later.
async function mountHostServices(ctx, home, { schedule = true } = {}) {
  const mountClass = async (specifier, exportName, config) => {
    const loaded = await import(specifier)
    await ctx.plugin(loaded[exportName] ?? loaded.default, config).await()
  }
  const mountFn = async (specifier, config) => {
    const loaded = await import(specifier)
    await ctx.plugin({ name: loaded.name, inject: loaded.inject, apply: loaded.apply }, config).await()
  }
  await mountClass('@deepseek-ai/dsh-system-prompt', 'SystemPrompt')
  await mountClass('@deepseek-ai/dsh-tools', 'ToolRuntime')
  await mountClass('@deepseek-ai/dsh-session', 'default')
  await mountClass('@deepseek-ai/dsh-session-projection', 'default')
  await mountClass('@deepseek-ai/dsh-session-title', 'SessionTitleService', { fallbackMaxWords: 8, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  await mountClass('@deepseek-ai/dsh-llm', 'default')
  await mountClass('@deepseek-ai/dsh-agent', 'default')
  await mountClass('@deepseek-ai/dsh-agent-default-model', 'default', { provider: 'deepseek', model: 'deepseek-chat' })
  await mountClass('@deepseek-ai/dsh-attachment-local', 'default', { dshHome: home })
  await mountClass('@deepseek-ai/dsh-commands', 'default')
  await mountClass('@deepseek-ai/dsh-fs-local', 'default', { cwd: home })
  await mountClass('@deepseek-ai/dsh-session-query-sqlite', 'default', { path: join(home, 'session-query.db') })
  await mountClass('@deepseek-ai/dsh-typert-registry', 'default')
  await mountClass('@deepseek-ai/dsh-working-directory', 'default', { defaultDirectory: home })
  await mountClass('@deepseek-ai/dsh-storage', 'default')
  await mountFn('@deepseek-ai/dsh-storage-json', { root: join(home, 'storage') })
  await mountFn('@deepseek-ai/dsh-storage-domain', { backend: 'json' })
  await mountFn('@deepseek-ai/dsh-session-persistence-jsonl', { root: join(home, 'sessions') })
  await mountClass('@deepseek-ai/dsh-workspace', 'WorkspaceRegistry')
  await mountClass('@deepseek-ai/dsh-credentials-local', 'LocalCredentialProvider', { path: join(home, '.credentials.yaml'), dshHome: home, watch: false })
  await mountFn('@deepseek-ai/dsh-client-connection')
  await mountClass('@deepseek-ai/dsh-client-file-upload', 'default')
  await mountClass('@deepseek-ai/dsh-api-remote-access', 'default')
  await mountClass('@deepseek-ai/dsh-api-session-controller', 'SessionController')
  await mountFn('@deepseek-ai/dsh-shell-env')
  await mountClass('@deepseek-ai/dsh-goal', 'GoalService')
  if (schedule) await ctx.plugin(ScheduleService).await()
}

// A minimal real provider: cordis registers the value under the name for the plugin's own fiber.
const providerPlugin = (name, value) => ({
  name: `${name}-provider`,
  apply(ctx) { ctx.provide(name, value) },
})

// The four dynamic injections run inside a module's install(rt), where ctx is the plugin's own
// context. This stands in for one install and hands the inject fiber back so a test can await it.
const installInjector = (name, attach) => {
  const state = {}
  const plugin = {
    name: `miasaki-dsbot-inject-${name}`,
    apply(ctx) { state.fiber = ctx.inject([name], attach) },
  }
  return [plugin, state]
}

// loader.import resolves through node's internal ESM loader against ctx.baseUrl, which a dsh
// profile anchors at the profile directory; anchor it at the directory that owns the harness's
// node_modules so the packages the static imports resolved stay reachable.
const harnessRoot = () => {
  let dir = new URL('./', import.meta.resolve(MCP_CLIENT))
  for (;;) {
    const parent = new URL('../', dir)
    if (parent.pathname === dir.pathname) throw new Error('no harness node_modules found')
    dir = parent
    if (dir.pathname.endsWith('/node_modules/')) return new URL('../', dir).href
  }
}

test('every service the plugin reads is a real, active service object with the members its call sites use', async t => {
  const home = tempHome()
  // Insurance against a provider falling back to the user's profile (AGENTS.md hard rule 5).
  process.env.DSH_HOME = home
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountHostServices(ctx, home)
  assert.deepEqual([...inject].sort(), ['connection', 'llm', 'sessionController', 'sessionTitle', 'sessions', 'systemPrompt', 'tools', 'workspaceRegistry'])
  for (const [name, members] of Object.entries(SERVICE_MEMBERS)) {
    const service = ctx.get(name)
    assert.notEqual(service, undefined, `${name} is not provided on the host context`)
    for (const member of members) {
      assert.equal(typeof service[member], 'function', `${name}.${member} is not callable`)
    }
  }
  // The two services read as data holders rather than callables.
  assert.equal(typeof ctx.get('sessions').messageProjections, 'object')
  assert.equal(typeof ctx.get('connection').fetch, 'object')
  // A fresh home holds no scheduled tasks.
  assert.deepEqual(await ctx.get('schedule').catalog(), [])
})

test('ctx.get answers undefined for a service nobody provided and never throws, with or without the optional call', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  assert.equal(typeof ctx.get, 'function')
  assert.equal(ctx.get('nothing-here'), undefined)
  assert.equal(ctx.get?.('nothing-here'), undefined)
  // The root context resolves a property read the same non-strict way.
  assert.equal(ctx.nothingHere, undefined)
  // The two guards the connector mount checks before using the loader.
  assert.equal(typeof ctx.inject, 'function')
  assert.equal(typeof ctx.plugin, 'function')
})

test('a service property read needs the inject while ctx.get reads any provided service', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(providerPlugin('alpha', { marker: 'a' })).await()
  await ctx.plugin(providerPlugin('beta', { marker: 'b' })).await()
  const seen = {}
  await ctx.plugin({
    name: 'miasaki-dsbot-reader',
    inject: ['alpha'],
    apply(reader) {
      seen.alpha = reader.alpha
      try { void reader.beta } catch (error) { seen.betaError = error.message }
      seen.alphaGet = reader.get('alpha')
      seen.betaGet = reader.get('beta')
      seen.missingGet = reader.get('nothing-here')
    },
  }).await()
  assert.deepEqual(seen.alpha, { marker: 'a' })
  assert.match(seen.betaError, /cannot get property "beta" without inject/u)
  // ctx.get has no inject requirement, which is why the code reads services through it.
  assert.deepEqual(seen.alphaGet, { marker: 'a' })
  assert.deepEqual(seen.betaGet, { marker: 'b' })
  assert.equal(seen.missingGet, undefined)
})

test('ctx.inject waits for the service and attaches when it appears later', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const attached = []
  const [plugin, state] = installInjector('sessionProjections', sub => { attached.push(sub) })
  await ctx.plugin(plugin).await()
  assert.deepEqual(attached, [])
  await ctx.plugin(SessionProjectionRegistry).await()
  await state.fiber.await()
  assert.equal(attached.length, 1)
  assert.equal(typeof attached[0].sessionProjections.register, 'function')
  assert.equal(typeof attached[0].sessionProjections.stateOf, 'function')
  assert.equal(typeof attached[0].effect, 'function')
})

test('ctx.inject never runs its callback when the service never appears', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let ran = false
  const [plugin, state] = installInjector('schedule', () => { ran = true })
  await ctx.plugin(plugin).await()
  // Awaiting settles without the callback: absent means the capability is not loaded.
  await state.fiber.await()
  assert.equal(ran, false)
})

test('ctx.inject hands the callback the provider\'s own instance and leaves the outer scope untouched', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const service = { marker: 'probe' }
  await ctx.plugin(providerPlugin('probe', service)).await()
  const seen = []
  const [plugin, state] = installInjector('probe', sub => { seen.push(sub) })
  await ctx.plugin(plugin).await()
  await state.fiber.await()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].probe, service)
  assert.equal(ctx.get('probe'), service)
  // A second injection of the same name attaches to the same instance; neither overrides the other.
  const [second, secondState] = installInjector('probe', sub => { seen.push(sub) })
  await ctx.plugin(second).await()
  await secondState.fiber.await()
  assert.equal(seen.length, 2)
  assert.equal(seen[1].probe, service)
  assert.equal(ctx.get('probe'), service)
})

test('unloading the provider releases the attached service and clears the outer scope', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const service = { marker: 'probe' }
  const provider = ctx.plugin(providerPlugin('probe', service))
  await provider.await()
  let released = null
  const [plugin, state] = installInjector('probe', sub => {
    const own = sub.probe
    sub.effect(() => () => { if (own === service) released = service }, 'ds-bot: probe service')
  })
  await ctx.plugin(plugin).await()
  await state.fiber.await()
  assert.equal(released, null)
  // The provider's unload runs the attach's effect disposer, the way DSH unloading the schedule,
  // shellEnv, sessionProjections or goals service would release the module that attached to it.
  await provider.dispose()
  assert.equal(released, service)
  assert.equal(ctx.get('probe'), undefined)
})

test('the real schedule service activates and the install-time inject attach sees it', async t => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountHostServices(ctx, home, { schedule: false })
  const attached = []
  const [plugin, state] = installInjector('schedule', sub => { attached.push(sub) })
  await ctx.plugin(plugin).await()
  assert.deepEqual(attached, [])
  await ctx.plugin(ScheduleService).await()
  await state.fiber.await()
  assert.equal(attached.length, 1)
  assert.equal(typeof attached[0].schedule.catalog, 'function')
  assert.deepEqual(await attached[0].schedule.catalog(), [])
})

test('loader.import mounts the real MCP client, its tool executes, and unmount removes it', async t => {
  // Stands in for connectors.js:78-94 and the MCP branch of capabilities.js:308-312: the loader
  // and mount API are the host's, the MCP server is the repo's own echo server over stdio.
  const ctx = new Context()
  ctx.baseUrl = harnessRoot()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(Loader).await()
  const loader = ctx.get?.('loader')
  assert.equal(typeof loader?.import, 'function')
  const exports = await loader.import(MCP_CLIENT)
  const plugin = loader.unwrapExports?.(exports) ?? exports?.default ?? exports
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['tools'])
  const fiber = ctx.plugin(plugin, { transport: 'stdio', serverName: 'echo', command: process.execPath, args: [ECHO_SERVER], env: {}, failOnStartupError: true })
  await fiber.await()
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['mcp__echo__echo'])
  const echo = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('mcp__echo__echo'), name: 'mcp__echo__echo', arguments: { text: 'locked' } })
  assert.equal(echo.isError, false)
  assert.deepEqual(echo.value, { content: [{ type: 'text', text: 'locked' }] })
  await fiber.dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
})

test('the capability skill mount registers through the skills service and its effect unregisters on dispose', async t => {
  // Stands in for capabilities.js:310's agent.ctx.plugin: the same cordis mount API, on a host
  // context instead of an Agent's own scope (the Agent object face is a separate contract).
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry).await()
  const fiber = ctx.plugin({
    name: 'miasaki-dsbot-capability-skill-echo',
    inject: ['skills'],
    apply(capability) {
      capability.effect(() => capability.skills.register({ name: 'echo-skill', description: 'Echo skill', source: 'runtime', content: 'Use when asked.' }))
    },
  })
  await fiber.await()
  const skills = ctx.get('skills')
  const skill = await skills.get('echo-skill')
  assert.equal(skill?.name, 'echo-skill')
  assert.equal(skill?.source, 'runtime')
  assert.equal(skill?.content, 'Use when asked.')
  await fiber.dispose()
  assert.equal(await skills.get('echo-skill'), undefined)
})

test('a DSH Service instance reads back as a fresh traceable proxy on every read', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry).await()
  const first = ctx.get('sessionProjections')
  const second = ctx.get('sessionProjections')
  // Service instances carry a tracker, so each read wraps a new proxy: the adapter layer must not
  // compare service objects or their methods by identity across reads.
  assert.notEqual(first, second)
  assert.notEqual(first.register, second.register)
  assert.equal(typeof first.register, 'function')
  assert.equal(typeof second.stateOf, 'function')
  // A plain provided value has no tracker: reads are the identical object.
  const plain = { marker: 'plain' }
  await ctx.plugin(providerPlugin('plain', plain)).await()
  assert.equal(ctx.get('plain'), ctx.get('plain'))
  assert.equal(ctx.get('plain'), plain)
})

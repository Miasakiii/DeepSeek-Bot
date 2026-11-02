// Behavior locks for three faces of the real DeepSeek Harness runtime that the host leans
// on (C0 execution baseline §C0.2): the `ctx.tools` registry the way src/host uses it —
// 26 `register()` calls, two `schemas()` reads, two `restrict()` calls and one `guard()` —
// the hidden `ctx.fiber` state parts.js:748 reads to notice that the plugin is being
// unloaded, and the two `ctx.connection` Fetch routes channel.js and feed.js mount on the
// shared /api channel. Every assertion was measured against the @deepseek-ai packages
// `npm run harness` installs; nothing here is taken from documentation.
//
// Run: node --import ./test/harness-resolve.mjs --test dev/contract/tools-and-hidden.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as connectionPackage from '@deepseek-ai/dsh-client-connection'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ROUTE } from '../../src/host/constants.js'
import { FEED_ROUTE } from '../../src/host/feed.js'
import { defineTool } from '../../src/host/vendor/tools.js'

// The package exports its plugin in parts (name, inject, Config, apply); this is the
// plugin object they compose into.
const Connection = {
  name: connectionPackage.name,
  inject: connectionPackage.inject,
  Config: connectionPackage.Config,
  apply: connectionPackage.apply,
}

// The output contract every src/host tool declares (src/host/tools.js:14), and the
// vendored defineTool all 26 registrations build their definition with.
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const tool = (name, execute, description = `${name} tool`, parameters = {}) => defineTool({ name, description, parameters, output, execute })

const execute = (ctx, name, args, agent) => ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId(name),
  name,
  arguments: args,
  ...(agent === undefined ? {} : { agent }),
})

// No turn runs in these locks; the adapter only answers model resolution so an Agent can
// be created.
class MockAdapter extends LlmAdapter {
  providerInfo() { return { id: 'mock', name: 'Mock' } }
  async listModels() { return [] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 100000 } }
  }
  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: options => this.stream(options) }
  }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

// The composition an Agent is resolved in, so `agent.ctx` is the scoped context the host
// restricts tools through. A session header carries an absolute cwd.
const cwd = process.platform === 'win32' ? 'C:\\tmp' : '/tmp'
async function open(t) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  t.after(async () => ctx.fiber.dispose())
  ctx.llm.registerAdapter(['mock'], new MockAdapter())
  const make = async id => (await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd },
    agentOptions: { provider: 'mock', model: 'mock-1' },
  })).agent
  return { ctx, make }
}

// The real Connection plugin signs its browser-session secret through a credentials
// provider; the file-backed one would write into a DSH home, and none of the locked
// surface reads the secret, so the one method the plugin calls is stubbed.
class Credentials extends Service {
  constructor(ctx) { super(ctx, 'credentials') }
  async modifyRecord(_key, edit) { return edit() }
}

async function openConnection(t) {
  const ctx = new Context()
  await ctx.plugin(Credentials)
  await ctx.plugin(Connection)
  t.after(async () => ctx.fiber.dispose())
  return ctx
}

// A POST to the api route, as the browser sends it.
const apiPost = body => new Request('http://localhost/api/bot', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

test('a registered tool is visible in the model-facing schemas and runs through the execution pipeline', async t => {
  const { ctx } = await open(t)
  let seen
  ctx.tools.register(tool('list_bots', (args, exec) => { seen = { args, name: exec.name }; return 'No Bots yet.' }, 'List every Bot on the team', { room: { type: 'string' } }))

  // schemas() projects the model-facing fields only: no execution or output callback
  // reaches the request.
  assert.deepEqual(ctx.tools.schemas(), [{
    name: 'list_bots',
    description: 'List every Bot on the team',
    parameters: { type: 'object', properties: { room: { type: 'string' } } },
  }])
  assert.equal('execute' in ctx.tools.schemas()[0], false)
  assert.equal(ctx.tools.get('list_bots')?.name, 'list_bots')
  // Every read is a fresh deep clone, so a caller that edits what it got cannot reach the
  // registered definition or the next read.
  const first = ctx.tools.schemas()[0]
  first.parameters.properties.room.type = 'number'
  assert.equal(ctx.tools.schemas()[0].parameters.properties.room.type, 'string')

  const result = await execute(ctx, 'list_bots', { room: 'general' })
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, 'No Bots yet.')
  assert.deepEqual(result.content, [{ type: 'text', text: 'No Bots yet.' }])
  assert.equal(Object.isFrozen(result), true, 'the outcome is a frozen snapshot')
  assert.equal(seen.name, 'list_bots')
  assert.deepEqual(seen.args, { room: 'general' })
})

test('register returns the disposer that takes the tool out of both surfaces', async t => {
  const { ctx } = await open(t)
  const dispose = ctx.tools.register(tool('probe', () => 'ran'))
  dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
  assert.equal(ctx.tools.get('probe'), undefined)
  const missing = await execute(ctx, 'probe', {})
  assert.equal(missing.isError, true)
  assert.equal(missing.error.message, 'unknown tool "probe"')
  assert.deepEqual(missing.error.info, { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
  assert.deepEqual(missing.content, [{ type: 'text', text: 'Error: unknown tool "probe"' }])
})

test('a tool registered through a plugin context belongs to that plugin\'s fiber', async t => {
  const { ctx } = await open(t)
  const plugin = inner => { inner.tools.register(tool('plugin_tool', () => 'ran')) }
  plugin.inject = ['tools']
  const fiber = await ctx.plugin(plugin)
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), ['plugin_tool'])
  // What unloads the host's 26 tools on a reload: the registration is owned by the fiber
  // that made it, not by the registry.
  await fiber.dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
})

test('the registry refuses a duplicate name, the reserved run_code transport, and a definition without an output contract', async t => {
  const { ctx } = await open(t)
  const first = tool('probe', () => 'ran')
  ctx.tools.register(first)
  assert.throws(() => ctx.tools.register(first), /tool "probe" is already registered \(for a per-agent variant/)
  assert.throws(() => ctx.tools.register(tool('run_code', () => 'ran')), /tool name "run_code" is reserved for the PTC mode presentation transport/)
  assert.throws(() => ctx.tools.register({ name: 'no_output', description: 'd', parameters: {}, execute: async () => 'x' }), {
    name: 'TypeError',
    message: 'tool "no_output" must declare output { schema, render, presentationMeta? }',
  })
})

test('schemas(agent) reports the global view for an agent nothing has been restricted for yet', async t => {
  const { ctx, make } = await open(t)
  ctx.tools.register(tool('probe', () => 'ran'))
  const a = await make('chat-a')
  const b = await make('chat-b')
  assert.deepEqual(ctx.tools.schemas(a).map(schema => schema.name), ['probe'])
  assert.deepEqual(ctx.tools.schemas(b).map(schema => schema.name), ['probe'])
  // A name this profile does not serve is simply absent, which is what the host filters
  // its deny list against before it calls restrict() (src/host/agents.js:52).
  assert.equal(ctx.tools.schemas(a).some(schema => schema.name === 'create_goal'), false)
})

test('a scoped restriction hides inherited global tools from one agent, in the schemas and at execution', async t => {
  const { ctx, make } = await open(t)
  let runs = 0
  ctx.tools.register(tool('probe', () => { runs += 1; return 'ran' }))
  const a = await make('chat-a')
  const b = await make('chat-b')

  const lift = a.ctx.tools.restrict({ deny: ['probe'] })
  assert.deepEqual(ctx.tools.schemas(a).map(schema => schema.name), [])
  assert.deepEqual(ctx.tools.schemas(b).map(schema => schema.name), ['probe'])
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), ['probe'])
  assert.equal(ctx.tools.get('probe', a), undefined)

  // A restricted-away tool reads as absent, not as denied: the same UNKNOWN_TOOL the
  // executor gives a name that was never registered.
  const denied = await execute(ctx, 'probe', {}, a)
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, 'unknown tool "probe"')
  assert.equal(runs, 0)
  assert.equal((await execute(ctx, 'probe', {}, b)).isError, false)
  assert.equal(runs, 1)

  lift()
  assert.deepEqual(ctx.tools.schemas(a).map(schema => schema.name), ['probe'])
  assert.equal((await execute(ctx, 'probe', {}, a)).isError, false)
  assert.equal(runs, 2)
})

test('restrict composes: allow keeps only the listed globals, deny intersects it, and a scope\'s own registration is exempt', async t => {
  const { ctx, make } = await open(t)
  for (const name of ['t1', 't2', 't3']) ctx.tools.register(tool(name, () => name))
  const a = await make('chat-a')

  a.ctx.tools.restrict({ allow: ['t1', 't2'] })
  assert.deepEqual(ctx.tools.schemas(a).map(schema => schema.name), ['t1', 't2'])
  a.ctx.tools.restrict({ deny: ['t2'] })
  assert.deepEqual(ctx.tools.schemas(a).map(schema => schema.name), ['t1'])

  // A scope's own layer is never filtered by its own restriction, so a name it registered
  // itself is not a "global tool" and cannot be named in a filter.
  a.ctx.tools.register(tool('own', () => 'own'))
  assert.deepEqual(ctx.tools.schemas(a).map(schema => schema.name), ['t1', 'own'])
  assert.throws(() => a.ctx.tools.restrict({ deny: ['own'] }), /names unknown global tool "own"; known global tools: /)
})

test('restrict refuses an empty filter, an unknown global name, and a context-global call', async t => {
  const { ctx, make } = await open(t)
  ctx.tools.register(tool('probe', () => 'ran'))
  const a = await make('chat-a')
  assert.throws(() => a.ctx.tools.restrict({}), /tools\.restrict\(\{\}\) is a no-op/)
  assert.throws(() => a.ctx.tools.restrict({ deny: ['ask_user_question'] }), /names unknown global tool "ask_user_question"/)
  assert.throws(() => ctx.tools.restrict({ deny: ['probe'] }), /requires a scoped context \(agent\.ctx\)/)
})

test('a guard denies before the tool body runs, and its disposer lifts the denial', async t => {
  const { ctx, make } = await open(t)
  let runs = 0
  ctx.tools.register(tool('ask_user_question', () => { runs += 1; return 'asked' }))
  const botChat = await make('bot-chat')
  const userChat = await make('user-chat')
  const isBotSession = id => id === 'bot-chat'
  const reason = 'Bots cannot use ask_user_question. Ask with ask_user in your own chat, or ask in your reply.'
  const seen = []

  const lift = ctx.tools.guard(exec => {
    seen.push({ name: exec.name, agentIsBotChat: exec.agent === botChat, frozen: Object.isFrozen(exec.arguments) })
    return exec.name === 'ask_user_question' && isBotSession(exec.agent?.id) ? reason : undefined
  })
  const denied = await execute(ctx, 'ask_user_question', {}, botChat)
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, reason)
  assert.deepEqual(denied.content, [{ type: 'text', text: `Error: ${reason}` }])
  assert.equal(runs, 0, 'the body never runs')
  assert.equal((await execute(ctx, 'ask_user_question', {}, userChat)).isError, false)
  assert.equal(runs, 1)
  // The guard sees the Agent the call was made for, by identity, so the host can key its
  // Session test off it.
  assert.deepEqual(seen, [
    { name: 'ask_user_question', agentIsBotChat: true, frozen: true },
    { name: 'ask_user_question', agentIsBotChat: false, frozen: true },
  ])

  lift()
  assert.equal((await execute(ctx, 'ask_user_question', {}, botChat)).isError, false)
  assert.equal(runs, 2)
})

test('guards run in registration order, the first denial wins, and no guard can force-allow', async t => {
  const { ctx } = await open(t)
  ctx.tools.register(tool('probe', () => 'ran'))
  const asked = []
  const first = ctx.tools.guard(() => { asked.push('first'); return undefined })
  const second = ctx.tools.guard(() => { asked.push('second'); return 'second denies' })
  const third = ctx.tools.guard(() => { asked.push('third'); return 'third never reached' })
  const result = await execute(ctx, 'probe', {})
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'second denies')
  assert.deepEqual(asked, ['first', 'second'])
  first(); second(); third()
})

test('ctx.fiber is the plugin\'s cordis fiber: uid 0 at the root, a number while live, null once unloaded', async t => {
  const { ctx } = await open(t)
  let inner, uidInDisposer
  const plugin = scope => {
    inner = scope
    scope.effect(() => () => { uidInDisposer = scope.fiber.uid }, 'probe')
  }
  plugin.inject = ['tools']
  const fiber = await ctx.plugin(plugin)

  assert.equal(ctx.fiber.uid, 0, 'the root fiber')
  assert.equal(typeof fiber.uid, 'number')
  assert.ok(fiber.uid > 0, 'a plugin fiber is allocated a positive uid')
  assert.equal(typeof inner.tools.execute, 'function')

  await fiber.dispose()
  assert.equal(inner.fiber.uid, null)
  // The uid is cleared before the unload disposers run, so a disposer already sees the
  // plugin as unloaded — the window parts.js:748 covers with the uid check alone.
  assert.equal(uidInDisposer, null)
})

test('an unloaded context answers a service lookup and a new effect with the inactive-context error', async t => {
  const { ctx } = await open(t)
  let inner, serviceInDisposer
  const plugin = scope => {
    inner = scope
    scope.effect(() => () => { serviceInDisposer = typeof scope.tools.execute }, 'probe')
  }
  plugin.inject = ['tools']
  const fiber = await ctx.plugin(plugin)
  await fiber.dispose()

  const messages = []
  for (const read of [
    () => inner.tools,
    () => inner.effect(() => () => {}, 'late effect'),
    () => inner.on('agent/status', () => {}),
  ]) {
    try {
      read()
      messages.push('no error')
    } catch (error) {
      messages.push(error.message)
    }
  }
  // The two observable forms of the same unload. Only the service-lookup form carries
  // the words the /in inactive context/ test in parts.js:748 looks for; the effect form
  // says "on", so it is the uid check that has to catch that one.
  assert.deepEqual(messages, [
    'cannot get required service "tools" in inactive context',
    'cannot create effect on inactive context',
    'cannot create effect on inactive context',
  ])
  assert.match(messages[0], /in inactive context/)
  assert.doesNotMatch(messages[1], /in inactive context/)

  // The unload disposers still run with the service store live, so a lookup inside them
  // succeeds and only the uid check catches that window. The core logger is not an
  // injected service and still answers afterwards.
  assert.equal(serviceInDisposer, 'function')
  inner.logger.warn('after unload')
})

test('the two host routes are exact Fetch routes on the shared /api channel and answer through it', async t => {
  const ctx = await openConnection(t)
  const seen = []
  // Exactly what channel.js:531 and feed.js:104 register.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      seen.push({ path: new URL(request.url).pathname, method: request.method, body: await request.text(), aborted: request.signal.aborted })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'ds-bot: api route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"revision":1}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } }),
  }), 'ds-bot: live feed route')

  assert.equal(ROUTE, '/api/bot')
  assert.equal(FEED_ROUTE, '/api/bot/feed')
  // The shared handler the /api webserver route bridges every request to.
  const handler = ctx.connection.createSharedFetchHandler('/api')

  const api = await handler.fetch(apiPost({ endpoint: 'ping', payload: {} }), ctx.connection.browserPeer)
  assert.equal(api.status, 200)
  assert.equal(api.headers.get('content-type'), 'application/json')
  assert.deepEqual(await api.json(), { ok: true })
  // The route reads its own buffered body off the dispatched request.
  assert.deepEqual(seen, [{ path: '/api/bot', method: 'POST', body: '{"endpoint":"ping","payload":{}}', aborted: false }])

  const feed = await handler.fetch(new Request('http://localhost/api/bot/feed'), ctx.connection.browserPeer)
  assert.equal(feed.status, 200)
  assert.equal(feed.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(await feed.text(), 'event: hello\ndata: {"revision":1}\n\n')

  // The bridge asks the route how the body arrives before it reads it. Both routes
  // declare 'buffered', which is also the default for a path no route covers.
  assert.equal(handler.requestBodyMode({ method: 'POST', url: new URL('http://localhost/api/bot') }), 'buffered')
  assert.equal(handler.requestBodyMode({ method: 'GET', url: new URL('http://localhost/api/bot') }), 'buffered')
  assert.equal(handler.requestBodyMode({ method: 'GET', url: new URL('http://localhost/api/session') }), 'buffered')
})

test('an exact Fetch route is served before the shared RPC channel, and what it does not cover falls through', async t => {
  const ctx = await openConnection(t)
  const served = []
  const routeDisposer = ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => { served.push('exact'); return Response.json({ served: 'exact' }) },
  }), 'ds-bot: api route')
  // DSH's own extension point on the shared /api channel: the interceptor every endpoint
  // the exact routes do not cover reaches.
  ctx.effect(() => ctx.connection.rpc.intercept('/api', endpoint => endpoint === 'bot',
    async (endpoint, payload, signal, peer) => {
      served.push(`interceptor:${endpoint}:${peer.principal.kind}`)
      return { ok: true, value: { served: 'interceptor', endpoint } }
    }), 'probe interceptor')

  const handler = ctx.connection.createSharedFetchHandler('/api')
  const envelope = { type: 'client-request', rpcId: 'r1', method: 'bot', payload: { endpoint: 'ping' } }
  const exact = await handler.fetch(apiPost(envelope), ctx.connection.browserPeer)
  assert.deepEqual(await exact.json(), { served: 'exact' })

  // A method the route does not declare is not served by it either; the shared RPC
  // channel is POST-only, so the request is not found.
  const wrongMethod = await handler.fetch(new Request('http://localhost/api/bot'), ctx.connection.browserPeer)
  assert.equal(wrongMethod.status, 404)
  assert.equal(await wrongMethod.text(), 'not found')

  // The route belongs to the fiber that registered it: once it is disposed the path
  // falls through to the shared channel.
  await routeDisposer()
  const through = await handler.fetch(apiPost(envelope), ctx.connection.browserPeer)
  assert.deepEqual(await through.json(), {
    type: 'server-response',
    rpcId: 'r1',
    result: { ok: true, value: { served: 'interceptor', endpoint: 'bot' } },
  })
  assert.deepEqual(served, ['exact', 'interceptor:bot:owner'])
})

test('the route registry validates its shape, refuses a duplicate path, and refuses a peer that is not the owner', async t => {
  const ctx = await openConnection(t)
  const register = route => ctx.connection.fetch.register(route)
  const route = { path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: async () => new Response('x') }
  assert.throws(() => register({ ...route, path: '/bot' }), { message: 'connection: invalid exact Fetch route "/bot"' })
  assert.throws(() => register({ ...route, path: '/api/bot/../x' }), { message: 'connection: invalid exact Fetch route "/api/bot/../x"' })
  assert.throws(() => register({ ...route, methods: [] }), { message: 'connection: exact Fetch route "/api/bot" declares no methods' })
  assert.throws(() => register({ ...route, methods: ['POST', 'POST'] }), { message: 'connection: exact Fetch route "/api/bot" repeats a method' })

  ctx.effect(() => ctx.connection.fetch.register(route), 'ds-bot: api route')
  // The collision surfaces when the registering effect runs, not when register() is called.
  assert.throws(() => ctx.effect(() => ctx.connection.fetch.register(route)), {
    message: 'connection: exact Fetch route "/api/bot" is already registered',
  })

  const handler = ctx.connection.createSharedFetchHandler('/api')
  const unknown = await handler.fetch(new Request('http://localhost/api/nope'), ctx.connection.browserPeer)
  assert.equal(unknown.status, 404)
  assert.equal(await unknown.text(), 'not found')
  const stranger = ctx.connection.createPeer({ principal: { kind: 'peer' } })
  const forbidden = await handler.fetch(apiPost({ endpoint: 'ping' }), stranger)
  assert.equal(forbidden.status, 403)
  assert.equal(await forbidden.text(), 'forbidden')
})

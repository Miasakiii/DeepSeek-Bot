// 对账锁：src/host/rt/dsh.js 的薄包装与真实宿主逐面对齐——包装只转发，不改变行为
// （dsh.js 文首纪律）。这里每个断言都成对：同一件事经 createHost(ctx) / agentView(agent) 包装
// 做一遍，再直接经真实 ctx / agent 做一遍，两侧可观测的结果必须一致。DSH Service 每次读回都是
// 新的可追踪代理（dev/contract/services.test.js:305-322），所以面对服务的对账比的是行为与状态，
// 不是对象身份；fiber 等非服务对象才直接比身份。
//
// 挂载模式复制自 dev/contract/services.test.js:44-80（起真实 cordis Context、按 profile 挂真实
// host 服务、全部指向测试临时 home）；Agent 挂载复制自 session-objects.test.js:26-67；connection
// 挂载与工具执行辅助复制自 tools-and-hidden.test.js:27-45/93-111。@deepseek-ai/* 经
// test/harness-resolve.mjs 解析，与其余锁测试相同。
//
// 覆盖：§1.1 八注入服务属性读、§1.2 ctx.get（含可选调用形式）、§1.3 inject、§1.4 plugin、§2 on 与
// emit 的顺序/prepend/传参、§4 effect 的 LIFO 卸载、§5 fiber.uid、§6 tools.register、§7 connection
// 精确路由、logger 与 attachments 的属性回退、host.js §8 排除面的边界，以及 §3 的 Agent/Inbox/
// Session 对象面。未驱动的是会跑真实 turn 的成员（followup、唤醒式 send、steer、inject、
// runMaintenance）：它们的语义已由 session-objects.test.js 锁定，对账只证明包装把调用送到了真实
// 对象上（以只入队的 send、cancel、whenIdle 与 inbox 读写为证）。
//
// Run: node --import ./test/harness-resolve.mjs --test dev/contract/rt-dsh-reconciliation.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as connectionPackage from '@deepseek-ai/dsh-client-connection'
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ScheduleService } from '@deepseek-ai/dsh-schedule'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { inject } from '../../index.js'
import { ROUTE } from '../../src/host/constants.js'
import { agentView, createHost, sessionView } from '../../src/host/rt/dsh.js'
import { defineTool } from '../../src/host/vendor/tools.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-contract-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// 复制自 dev/contract/services.test.js:27-39：src/host 各调用点用到的成员表。前七个是
// index.js:48 inject 的，connection 与后四个只按服务整体读（connection 的成员面未列入该表，
// 见 services.test.js:129 的数据持有者读法）。
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

// 复制自 dev/contract/services.test.js:44-80：dsh host profile 在插件之下组合的 provider 树，
// 每一行都在裸 Context 上观测到可激活，每个路径都指向测试临时 home，不碰用户自己的 profile。
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

// 复制自 dev/contract/services.test.js:83-86：一个最小真实 provider，cordis 把值按名字注册到
// 该插件自己的 fiber 上。
const providerPlugin = (name, value) => ({
  name: `${name}-provider`,
  apply(ctx) { ctx.provide(name, value) },
})

// 复制自 dev/contract/tools-and-hidden.test.js:36-45：src/host 工具声明的 output 契约、vendored
// defineTool，以及模型面之外的执行入口。
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const tool = (name, execute, description = `${name} tool`, parameters = {}) => defineTool({ name, description, parameters, output, execute })
const execute = (ctx, name, args, agent) => ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId(name),
  name,
  arguments: args,
  ...(agent === undefined ? {} : { agent }),
})

// 复制自 dev/contract/tools-and-hidden.test.js:27-32/93-111：connection 包把插件拆成几部分导出，
// 这里拼回插件对象；它签名用的 credentials provider 换成只实现一个方法的桩，免得写进某个
// DSH home。apiPost 就是浏览器发来的那种 POST。
const Connection = {
  name: connectionPackage.name,
  inject: connectionPackage.inject,
  Config: connectionPackage.Config,
  apply: connectionPackage.apply,
}
class Credentials extends Service {
  constructor(ctx) { super(ctx, 'credentials') }
  async modifyRecord(_key, edit) { return edit() }
}
const openConnection = async t => {
  const ctx = new Context()
  await ctx.plugin(Credentials)
  await ctx.plugin(Connection)
  t.after(async () => ctx.fiber.dispose())
  return ctx
}
const apiPost = body => new Request('http://localhost/api/bot', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

// 复制自 session-objects.test.js:26-67：真实 SessionStore、AgentRegistry、SystemPrompt、
// ToolRuntime、LlmRuntime、SessionProjectionRegistry 与 AgentLoop 挂在一个真实 Context 上，
// ctx.agents.create 建出真实 Agent；唯一替身是 provider 线（一个最小 LlmAdapter，无需 key）。
class ScriptedAdapter extends LlmAdapter {
  providerInfo() { return { id: 'contract', name: 'Contract' } }
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
    yield { type: 'text-delta', index: 0, text: 'ack' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: 'stop' }
  }
}
const prompt = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const cwd = process.platform === 'win32' ? 'C:\\contract' : '/contract'
async function openAgent(t, id) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  t.after(async () => ctx.fiber.dispose())
  ctx.llm.registerAdapter(['contract'], new ScriptedAdapter())
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd },
    agentOptions: { provider: 'contract', model: 'contract-1' },
  })
  return { ctx, agent: handle.agent }
}

test('the eight injected services read through the wrapper as the real active services', async t => {
  const home = tempHome()
  // 同 services.test.js:115 的保险：防止某个 provider 回落到用户自己的 profile（AGENTS.md 硬规则 5）。
  process.env.DSH_HOME = home
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountHostServices(ctx, home)
  const host = createHost(ctx)
  // 包装上的八个服务属性正是 index.js:48 inject 的那八个（services.test.js:119 同款钉法）。
  assert.deepEqual([...inject].sort(), ['connection', 'llm', 'sessionController', 'sessionTitle', 'sessions', 'systemPrompt', 'tools', 'workspaceRegistry'])
  for (const name of inject) {
    const viaWrapper = host[name]
    const viaCtx = ctx.get(name)
    assert.notEqual(viaWrapper, undefined, `${name} is not readable through the wrapper`)
    assert.notEqual(viaCtx, undefined, `${name} is not provided on the host context`)
    // 读穿而非快照：dsh.js:33-53 一律写成 getter，正因为 DSH Service 每次读回都是新的可追踪代理
    // （services.test.js:305-322）。包装若在 createHost 时把服务存进闭包，这两读就会相同。
    assert.notEqual(viaWrapper, host[name], `${name} was snapshotted by the wrapper instead of read through`)
    assert.notEqual(viaCtx, ctx.get(name), `${name} reads back stably on the host context`)
    // connection 的成员面未列入 services.test.js:27-39 的表，只按下面的数据持有者读法钉；
    // 其余七个逐成员钉可调用，包装与真实 ctx 两侧都钉。
    for (const member of SERVICE_MEMBERS[name] ?? []) {
      assert.equal(typeof viaWrapper[member], 'function', `${name}.${member} is not callable through the wrapper`)
      assert.equal(typeof viaCtx[member], 'function', `${name}.${member} is not callable on the host context`)
    }
  }
  // 两个当数据持有者读的服务（services.test.js:128-129）。
  assert.equal(typeof host.sessions.messageProjections, 'object')
  assert.equal(typeof ctx.get('sessions').messageProjections, 'object')
  assert.equal(typeof host.connection.fetch, 'object')
  assert.equal(typeof ctx.get('connection').fetch, 'object')

  // §1.2 读法 2：十一个服务面名字经包装的 get 全部落在真实活跃服务上，成员可调用。
  for (const [name, members] of Object.entries(SERVICE_MEMBERS)) {
    const service = host.get(name)
    assert.notEqual(service, undefined, `${name} is not readable through host.get`)
    for (const member of members) {
      assert.equal(typeof service[member], 'function', `host.get('${name}').${member} is not callable`)
    }
  }
  // 新 home 里没有排定任务（services.test.js:130-131）。
  assert.deepEqual(await host.get('schedule').catalog(), [])

  // 成对只读调用：包装读到的是同一个活跃服务的同一份状态，不是副本。
  assert.deepEqual(host.tools.schemas(), ctx.tools.schemas())
  assert.deepEqual(await host.llm.listProviders(), await ctx.llm.listProviders())
  assert.deepEqual(
    (await host.systemPrompt.assemble({})).sections.map(section => section.name),
    (await ctx.systemPrompt.assemble({})).sections.map(section => section.name),
  )
  assert.deepEqual(await host.sessionController.list(), await ctx.sessionController.list())
  assert.deepEqual(await host.workspaceRegistry.list(), await ctx.workspaceRegistry.list())
})

test('ctx.get through the wrapper answers undefined for a name nobody provided and never throws', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  assert.equal(typeof host.get, 'function')
  // 可选调用形式（src/host 的 ctx.get?.() 写法）与直接调用一样落定，从不抛。
  assert.doesNotThrow(() => host.get('nothing-here'))
  assert.equal(host.get('nothing-here'), undefined)
  assert.equal(host.get?.('nothing-here'), undefined)
  // 成对：真实 ctx 的同一读法（services.test.js:134-145）。
  assert.equal(ctx.get('nothing-here'), undefined)
  assert.equal(ctx.get?.('nothing-here'), undefined)
  // 有人 provide 的普通值没有 tracker，包装读到的是同一个对象（services.test.js:318-321）。
  const value = { marker: 'probe' }
  await ctx.plugin(providerPlugin('probe', value))
  assert.equal(host.get('probe'), value)
  assert.equal(ctx.get('probe'), value)
  assert.equal(host.get('probe'), ctx.get('probe'))
})

test('a tool registered through the wrapper lands in the real registry, runs, and its disposer takes it out', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const host = createHost(ctx)
  let seen
  const dispose = host.tools.register(tool('recon_probe', (args, exec) => {
    seen = { args, name: exec.name }
    return 'No Bots yet.'
  }, 'List every Bot on the team', { room: { type: 'string' } }))

  // 注册落在真实 ctx.tools 上：模型面投影只有名字、描述与参数，执行回调不外泄
  // （tools-and-hidden.test.js:118-131 同款）。
  assert.deepEqual(ctx.tools.schemas(), [{
    name: 'recon_probe',
    description: 'List every Bot on the team',
    parameters: { type: 'object', properties: { room: { type: 'string' } } },
  }])
  assert.equal('execute' in ctx.tools.schemas()[0], false)
  assert.equal(ctx.tools.get('recon_probe')?.name, 'recon_probe')

  // 经真实 ctx.tools 执行，工具体拿到包装注册时的那一份。
  const result = await execute(ctx, 'recon_probe', { room: 'general' })
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, 'No Bots yet.')
  assert.deepEqual(result.content, [{ type: 'text', text: 'No Bots yet.' }])
  assert.deepEqual(seen, { args: { room: 'general' }, name: 'recon_probe' })

  // 包装交回的 disposer 摘得掉真实注册表里的工具（tools-and-hidden.test.js:142-153）。
  dispose()
  assert.deepEqual(ctx.tools.schemas(), [])
  assert.equal(ctx.tools.get('recon_probe'), undefined)
  const missing = await execute(ctx, 'recon_probe', {})
  assert.equal(missing.isError, true)
  assert.equal(missing.error.message, 'unknown tool "recon_probe"')

  // 反方向：直接经 ctx 注册的工具，经包装的 schemas()/get() 同样读得到。
  const direct = ctx.tools.register(tool('direct_probe', () => 'ran'))
  assert.deepEqual(host.tools.schemas().map(schema => schema.name), ['direct_probe'])
  assert.equal(host.tools.get('direct_probe')?.name, 'direct_probe')
  direct()
  assert.deepEqual(host.tools.schemas(), [])
})

test('listeners registered through the wrapper keep registration order and prepend against the direct surface', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  const order = []
  // 混排：经包装注册的与直接经 ctx 注册的按注册序触发，包装既不抢前也不落后
  // （events.test.js:88-100 的顺序，加上包装这一路）。
  ctx.on('agent/status', () => order.push('direct-1'))
  host.on('agent/status', () => order.push('wrap-1'))
  ctx.on('agent/status', () => order.push('direct-2'))
  host.on('agent/status', () => order.push('wrap-2'))
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['direct-1', 'wrap-1', 'direct-2', 'wrap-2'])

  // 经包装的 emit 原样传参：监听器只收到发射过去的实参，没有被追加 next（dsh.js:81-86：
  // 分发模式由发射方选，waterfall 才由宿主追加 next，本面不包这一层）。
  const seen = []
  host.on('probe/args', (...args) => seen.push(args))
  host.emit('probe/args', { a: 1 })
  ctx.emit('probe/args', { b: 2 })
  assert.deepEqual(seen, [[{ a: 1 }], [{ b: 2 }]])

  // prepend 经包装同样插到该事件所有已注册监听之前（events.test.js:102-115）。
  order.length = 0
  host.on('agent/status', () => order.push('wrap-prepend'), { prepend: true })
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['wrap-prepend', 'direct-1', 'wrap-1', 'direct-2', 'wrap-2'])
  // 多个 prepend：后来者更靠前（events.test.js:117-127）。
  order.length = 0
  host.on('agent/status', () => order.push('wrap-prepend-2'), { prepend: true })
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['wrap-prepend-2', 'wrap-prepend', 'direct-1', 'wrap-1', 'direct-2', 'wrap-2'])

  // on 经包装返回的仍是宿主的卸载函数，调用即摘掉。
  const drop = host.on('agent/status', () => order.push('droppable'))
  assert.equal(typeof drop, 'function')
  drop()
  order.length = 0
  ctx.emit('agent/status', { status: 'idle' })
  assert.equal(order.includes('droppable'), false)

  // 监听挂在注册它的 fiber 上：经包装在插件自己的 ctx 上注册，随该插件卸载一并移除
  // （events.test.js:687-696）。
  order.length = 0
  let inner
  const fiber = await ctx.plugin(scope => { inner = scope })
  createHost(inner).on('probe/fiber', () => order.push('plugin-wrap'))
  ctx.emit('probe/fiber', {})
  assert.deepEqual(order, ['plugin-wrap'])
  await fiber.dispose()
  ctx.emit('probe/fiber', {})
  assert.deepEqual(order, ['plugin-wrap'])
})

test('effects registered through the wrapper share the real fiber and unload LIFO, async disposers included', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  const marks = []
  // 经包装拿到的是宿主自己的 EffectDisposer：可调用、是 thenable、带着注册时的 label
  // （effects.test.js:34-38）。
  const slow = host.effect(() => async () => {
    marks.push('wrap-slow start')
    await sleep(15)
    marks.push('wrap-slow end')
  }, 'wrap-slow')
  assert.equal(typeof slow, 'function')
  assert.equal(typeof slow.then, 'function')
  assert.equal(slow[Context.effect].label, 'wrap-slow')
  // 混排：经包装与直接经 ctx 注册的 effect 同在根 fiber 上，按注册序入列。
  ctx.effect(() => () => marks.push('direct-mid'), 'direct-mid')
  host.effect(() => async () => {
    marks.push('wrap-quick start')
    await sleep(1)
    marks.push('wrap-quick end')
  }, 'wrap-quick')
  ctx.effect(() => () => marks.push('direct-last'), 'direct-last')
  assert.deepEqual(ctx.fiber.getEffects().map(meta => meta.label), ['wrap-slow', 'direct-mid', 'wrap-quick', 'direct-last'])

  await ctx.fiber.dispose()
  // LIFO：反向注册序起跑，同步 disposer 就地跑完，异步的各自落定，unload 等最慢的那个
  // （effects.test.js:54-70/104-121）。
  assert.deepEqual(marks, ['direct-last', 'wrap-quick start', 'direct-mid', 'wrap-slow start', 'wrap-quick end', 'wrap-slow end'])

  // await 这个 disposer 只等 body 落定、不处置（effects.test.js:158-164）：经包装返回的就是
  // 宿主那个对象，语义原样。
  const late = new Context()
  t.after(() => late.fiber.dispose())
  const lateMarks = []
  const wrapper = createHost(late).effect(() => {
    lateMarks.push('setup')
    return () => lateMarks.push('dispose')
  }, 'thenable')
  await wrapper
  assert.deepEqual(lateMarks, ['setup'])
  assert.deepEqual(late.fiber.getEffects().map(meta => meta.label), ['thenable'])
  await late.fiber.dispose()
  assert.deepEqual(lateMarks, ['setup', 'dispose'])
})

test("the wrapper's fiber is the real fiber: the same uid while alive, null once unloaded", async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  // fiber 不是 Service，读回同一对象；根 fiber uid 为 0（tools-and-hidden.test.js:292-312）。
  assert.equal(host.fiber, ctx.fiber)
  assert.equal(host.fiber.uid, ctx.fiber.uid)
  assert.equal(ctx.fiber.uid, 0, 'the root fiber')
  assert.notEqual(host.fiber.uid, null)

  // 插件 fiber：正数 uid，包装与真实 ctx 读到同一个。
  let inner, host2, uidInDisposer
  const plugin = scope => {
    inner = scope
    host2 = createHost(scope)
    scope.effect(() => () => { uidInDisposer = host2.fiber.uid }, 'probe')
  }
  const fiber = await ctx.plugin(plugin)
  assert.equal(host2.fiber, inner.fiber)
  assert.equal(host2.fiber.uid, fiber.uid)
  assert.equal(typeof host2.fiber.uid, 'number')
  assert.ok(host2.fiber.uid > 0, 'a plugin fiber is allocated a positive uid')

  await fiber.dispose()
  assert.equal(host2.fiber.uid, null)
  assert.equal(inner.fiber.uid, null)
  // uid 在卸载 disposer 运行之前就被清掉（parts.js:748 的「卸载期」谓词只靠这一条），
  // 经包装读也一样。
  assert.equal(uidInDisposer, null)
})

test('an exact Fetch route registered through the wrapper answers on the shared /api channel and falls through once disposed', async t => {
  const ctx = await openConnection(t)
  const host = createHost(ctx)
  const seen = []
  // channel.js:531 的注册形状，整条经包装：effect 经包装注册，路由从 host.connection 读出。
  const routeDisposer = host.effect(() => host.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      seen.push({ path: new URL(request.url).pathname, method: request.method, body: await request.text() })
      return Response.json({ served: 'wrapper' })
    },
  }), 'ds-bot: api route')
  assert.equal(ROUTE, '/api/bot')
  const handler = host.connection.createSharedFetchHandler('/api')
  const peer = host.connection.browserPeer

  const api = await handler.fetch(apiPost({ endpoint: 'ping', payload: {} }), peer)
  assert.equal(api.status, 200)
  assert.deepEqual(await api.json(), { served: 'wrapper' })
  // 路由自己从分发下来的 request 读缓冲体（tools-and-hidden.test.js:390-391 同款）。
  assert.deepEqual(seen, [{ path: '/api/bot', method: 'POST', body: '{"endpoint":"ping","payload":{}}' }])

  // 摘掉经包装注册的路由：该路径落回共享通道，GET 无人认领（tools-and-hidden.test.js:429-431/461-463）。
  await routeDisposer()
  const gone = await handler.fetch(new Request('http://localhost/api/bot'), peer)
  assert.equal(gone.status, 404)
  assert.equal(await gone.text(), 'not found')

  // 反方向：直接经 ctx 注册的同一路径，经包装读到的连接服务同样认领——两个面落在同一个注册表上。
  const direct = ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => Response.json({ served: 'direct' }),
  }), 'ds-bot: api route direct')
  const again = await handler.fetch(apiPost({ endpoint: 'ping', payload: {} }), peer)
  assert.deepEqual(await again.json(), { served: 'direct' })
  await direct()
})

test('ctx.inject through the wrapper attaches when the service appears later and settles when it never does', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  const value = { marker: 'probe' }
  const attached = []
  const fiber = host.inject(['probe'], sub => { attached.push(sub) })
  assert.equal(typeof fiber.await, 'function')
  await ctx.plugin(providerPlugin('probe', value))
  await fiber.await()
  // attach 收到的是提供方自己的实例（services.test.js:198-217）：经包装原样透传，不包子上下文，
  // 一包就破坏实例同一性。
  assert.equal(attached.length, 1)
  assert.equal(attached[0].probe, value)
  assert.equal(ctx.get('probe'), value)

  // 永不出现的服务：fiber.await() 正常落定，attach 不执行（services.test.js:187-196）。
  let ran = false
  const never = host.inject(['never'], () => { ran = true })
  await never.await()
  assert.equal(ran, false)
})

test('ctx.plugin through the wrapper mounts on the real context and its fiber unloads it', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  const fiber = host.plugin(providerPlugin('probe', { marker: 'probe' }))
  assert.equal(typeof fiber.await, 'function')
  assert.equal(typeof fiber.dispose, 'function')
  await fiber.await()
  // 挂载落在真实 ctx 上：直接经 ctx.get 与经包装的 get 读到同一个提供的值。
  assert.deepEqual(ctx.get('probe'), { marker: 'probe' })
  assert.deepEqual(host.get('probe'), { marker: 'probe' })
  await fiber.dispose()
  assert.equal(ctx.get('probe'), undefined)
  assert.equal(host.get('probe'), undefined)
  assert.equal(fiber.uid, null)
})

test('the logger reads through the wrapper to the real context logger', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  assert.equal(typeof host.logger.warn, 'function')
  // logger 不是注入服务，但同样读穿：换掉真实 ctx 的 logger，经包装立刻读到新的那个
  // （tools-and-hidden.test.js:352-353 只钉了卸载后仍可用）。
  const seen = []
  ctx.logger = { warn: (...args) => seen.push(args.map(String).join(' ')), info() {} }
  host.logger.warn('through the wrapper')
  ctx.logger.warn('direct')
  assert.deepEqual(seen, ['through the wrapper', 'direct'])
  // 换上的普通对象没有 tracker，两侧读到同一对象（services.test.js:318-321）。
  assert.equal(host.logger, ctx.logger)
})

test('the attachments property fallback reads the real service when provided and undefined when nobody provides it', async t => {
  const bare = new Context()
  t.after(() => bare.fiber.dispose())
  // 无人提供：属性读作 undefined，与真实 ctx 的读法一致（dsh.js:107-112）。
  assert.equal(createHost(bare).attachments, undefined)
  assert.equal(bare.attachments, undefined)

  const home = tempHome()
  process.env.DSH_HOME = home
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(AttachmentLocal, { dshHome: home })
  const host = createHost(ctx)
  assert.equal(typeof host.attachments, 'object')
  assert.equal(typeof ctx.attachments, 'object')
  // 同样是读穿：每次读回新的可追踪代理（services.test.js:305-322）。
  assert.notEqual(host.attachments, host.attachments)
})

test('the wrapper carries exactly the documented context face and none of the §8 exclusions', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const host = createHost(ctx)
  // dsh.js:22-24 的上下文本面：§1 服务面八个属性、§1.2 get、§1.3 inject、§1.4 plugin、§2 on 与
  // emit、§4 effect、§5 fiber，加 logger 与 attachments 两个属性回退。一个不多，一个不少。
  assert.deepEqual(Object.keys(host).sort(), [
    'llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection',
    'get', 'inject', 'plugin', 'on', 'emit', 'effect', 'fiber', 'logger', 'attachments',
  ].sort())
  // host.js §8 明确排除的面（dsh.js:18-20）：真实 ctx 上它们是有的，包装对象上读不到——
  // 排除是设计决定，这里把它钉住，免得以后悄悄多转发一个名字。
  for (const name of ['waterfall', 'bail', 'serial', 'once']) {
    assert.equal(typeof ctx[name], 'function', `${name} should exist on the real context`)
    assert.equal(name in host, false, `${name} should not be forwarded by the wrapper`)
    assert.equal(host[name], undefined)
  }
})

test('agentView forwards the real Agent: identity, the inbox face, and the agent-scoped context', async t => {
  const { ctx, agent } = await openAgent(t, 'recon-agent')
  const view = agentView(agent)
  // 标量面与真实 Agent 一致；session 直接给真实对象（dsh.js:127-132：DSH 的会话存储按对象身份
  // 认 Session，包一层就认不出来了）。
  assert.equal(view.id, agent.id)
  assert.equal(view.session, agent.session)
  assert.equal(view.status, agent.status)

  // inboxView：两个命名列表读穿，计算键访问同样有效（session-objects.test.js:69-79）。
  assert.deepEqual(view.inbox.nextStep, agent.inbox.nextStep)
  assert.deepEqual(view.inbox['nextTurn'], agent.inbox.nextTurn)
  // 经包装的 send 只入队不唤醒，真实 Agent 的 inbox 随即看得到（session-objects.test.js:146-152）。
  view.send(prompt('parked'), 'next-step', false)
  assert.equal(agent.status, 'idle')
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])
  assert.deepEqual(view.inbox.nextStep.map(message => message.content[0].text), ['parked'])
  // remove 经包装摘掉的就是真实 inbox 里那条，返回值与真实 inbox 随后的状态一致
  // （session-objects.test.js:106-119）。
  const parked = agent.inbox.nextStep[0]
  assert.equal(view.inbox.remove(parked.id), true)
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.equal(view.inbox.remove('no-such-message'), false)

  // cancel 经包装清掉真实 Agent 的待办（session-objects.test.js:216-227）。
  view.inbox.prepend('next-turn', prompt('queued'))
  view.cancel({ kind: 'user' })
  assert.deepEqual(agent.inbox.nextTurn, [])

  // whenIdle 透传到真实 Agent（parts.js:866 的等驱动空闲）。
  await view.whenIdle()
  assert.equal(agent.status, 'idle')

  // agent.ctx 是与宿主同形状的读穿面（dsh.js:163-172）：fiber 同一个，工具限制落在真实注册表上，
  // 且只影响本 Agent（session-objects.test.js:229-258 锁的是直接调用那一侧）。
  const agentHost = view.ctx
  assert.equal(agentHost.fiber, agent.ctx.fiber)
  assert.equal(agentHost.fiber.uid, agent.ctx.fiber.uid)
  ctx.tools.register(tool('recon_probe', () => 'ran'))
  const other = (await ctx.agents.create({
    sessionId: SessionId('recon-agent-other'),
    meta: { cwd },
    agentOptions: { provider: 'contract', model: 'contract-1' },
  })).agent
  const lift = agentHost.tools.restrict({ deny: ['recon_probe'] })
  assert.deepEqual(ctx.tools.schemas(agent).map(schema => schema.name), [])
  assert.deepEqual(ctx.tools.schemas(other).map(schema => schema.name), ['recon_probe'])
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), ['recon_probe'])
  lift()
  assert.deepEqual(ctx.tools.schemas(agent).map(schema => schema.name), ['recon_probe'])

  // 经包装在 agent.ctx 上注册的监听，由 agent.ctx 的 emit 按注册序触发，与直接注册的混排一致。
  const order = []
  agentHost.on('probe/order', () => order.push('wrap'))
  agent.ctx.on('probe/order', () => order.push('direct'))
  agent.ctx.emit('probe/order', {})
  assert.deepEqual(order, ['wrap', 'direct'])
})

test('sessionView reads and appends through to the real Session', async t => {
  const { agent } = await openAgent(t, 'recon-session')
  const session = agent.session
  const view = sessionView(session)
  // 日志身份与真实 Session 一致，且与 agent.id 相同（session-objects.test.js:381-393）。
  assert.equal(view.id, session.id)
  assert.equal(view.id, agent.id)
  assert.equal(view.seq, session.seq)
  assert.equal(view.header.id, session.id)
  assert.deepEqual(view.requestHeader(), session.requestHeader())
  assert.deepEqual(view.deriveMessages(), session.deriveMessages())

  // append 经包装追加到真实日志：seq 恰增一，eventAt 按新序号取到同一条
  // （session-objects.test.js:294-309/374）。
  const before = session.seq
  const event = view.append('plugin:recon/ping', { note: 'hi' })
  assert.equal(event.seq, before)
  assert.equal(session.seq, before + 1)
  assert.deepEqual(session.eventAt(before), event)
  // deriveMessages 经包装仍与真实 Session 一致（跟随 surface 替换而非原始日志）。
  assert.deepEqual(view.deriveMessages(), session.deriveMessages())
})

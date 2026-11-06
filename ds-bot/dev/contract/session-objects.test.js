// Contract locks for the DSH Agent/Session object face (C0 execution baseline §C0.2, landing 3).
// Every assertion here was produced by running the real @deepseek-ai packages that
// `npm run harness` installs in dev/harness: a real cordis Context mounts the real
// SessionStore, AgentRegistry, SystemPrompt, ToolRuntime, LlmRuntime,
// SessionProjectionRegistry and AgentLoop, and a real ReactLoopAgent is created
// through ctx.agents.create(). Nothing is stubbed except the provider wire, which
// is one minimal LlmAdapter so a turn can run without a key.
//
// Run: node --import ./test/harness-resolve.mjs --test dev/contract/session-objects.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const TOOL_OUTPUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const IMAGE = { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }

// One text block per call; the loop needs a settled stream, not a real model.
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

async function openAgent(t, id, { imageOffload = false } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  // The offload projection is contributed by its owning plugin, so the
  // `image/offload` append below only works where that plugin is mounted.
  if (imageOffload) await ctx.plugin(ImageOffload)
  t.after(async () => ctx.fiber.dispose())
  ctx.llm.registerAdapter(['contract'], new ScriptedAdapter())
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: 'C:\\contract' },
    agentOptions: { provider: 'contract', model: 'contract-1' },
  })
  return { ctx, agent: handle.agent, dispose: () => handle.dispose() }
}

test('a fresh agent has an empty durable inbox that reads as two named lists', async t => {
  const { agent } = await openAgent(t, 'inbox-empty')
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.deepEqual(agent.inbox.nextTurn, [])
  // groups.js:415 reads the list through a computed key, so the getters must
  // answer to plain property access as well.
  assert.deepEqual(agent.inbox['nextStep'], [])
  assert.deepEqual(agent.inbox['nextTurn'], [])
  assert.equal(agent.inbox.hasPending, false)
  assert.equal(agent.session.seq, 0)
})

test('inbox.prepend puts a message at the front of its own list and append at the end', async t => {
  const { agent } = await openAgent(t, 'inbox-prepend')
  const texts = list => list.map(message => message.content[0].text)
  agent.inbox.prepend('next-step', prompt('first'))
  agent.inbox.prepend('next-step', prompt('second'))
  agent.inbox.append('next-step', prompt('third'))
  agent.inbox.prepend('next-turn', prompt('turn-a'))
  agent.inbox.append('next-turn', prompt('turn-b'))

  assert.deepEqual(texts(agent.inbox.nextStep), ['second', 'first', 'third'])
  assert.deepEqual(texts(agent.inbox.nextTurn), ['turn-a', 'turn-b'])

  // Every mutation is a durable splice, so the pending lists survive a fold of
  // the log rather than living only in this process.
  const splices = agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')
  assert.deepEqual(splices.map(event => [event.data.target, event.data.start]), [
    ['next-step', 0],
    ['next-step', 0],
    ['next-step', 2],
    ['next-turn', 0],
    ['next-turn', 1],
  ])
  assert.deepEqual(splices.map(event => event.data.inserted[0].content[0].text), ['first', 'second', 'third', 'turn-a', 'turn-b'])
})

test('inbox.remove drops one pending message by id and reports whether it was pending', async t => {
  const { ctx, agent } = await openAgent(t, 'inbox-remove')
  agent.inbox.prepend('next-step', prompt('keep'))
  agent.inbox.prepend('next-step', prompt('drop'))
  const kept = agent.inbox.nextStep.find(message => message.content[0].text === 'keep')

  assert.equal(agent.inbox.remove(kept.id), true)
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['drop'])
  assert.equal(agent.inbox.remove('no-such-message'), false)

  // The live list and the durable `inbox` projection agree after a removal.
  const state = ctx.sessionProjections.stateOf(agent.session, 'inbox')
  assert.deepEqual(state['next-step'].map(message => message.content[0].text), ['drop'])
})

test('inbox.clear empties both lists, cancelling next-step before next-turn', async t => {
  const { agent } = await openAgent(t, 'inbox-clear')
  agent.inbox.prepend('next-step', prompt('step'))
  agent.inbox.prepend('next-turn', prompt('turn'))
  agent.inbox.clear()

  assert.deepEqual(agent.inbox.nextStep, [])
  assert.deepEqual(agent.inbox.nextTurn, [])
  assert.equal(agent.inbox.hasPending, false)
  const canceled = agent.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
    .map(event => event.data.target)
  assert.deepEqual(canceled, ['next-step', 'next-turn'])
})

test('inbox.prepend is durable state and does not wake the driver', async t => {
  const { agent } = await openAgent(t, 'inbox-no-wake')
  agent.inbox.prepend('next-step', prompt('parked'))
  assert.equal(agent.status, 'idle')
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])
  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])
})

test('agent.send parks input without a wake, and one wake drains the whole pending queue', async t => {
  const parked = await openAgent(t, 'inbox-send-park')
  parked.agent.send(prompt('parked'), 'next-step', false)
  assert.equal(parked.agent.status, 'idle')
  await parked.agent.whenIdle()
  assert.equal(parked.agent.status, 'idle')
  assert.deepEqual(parked.agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])

  const { agent } = await openAgent(t, 'inbox-send')
  const claimed = []
  agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => claimed.push([message.content[0].text, turn]))

  agent.inbox.prepend('next-step', prompt('step-1'))
  agent.inbox.append('next-step', prompt('step-2'))
  agent.inbox.prepend('next-turn', prompt('turn-1'))
  agent.inbox.append('next-turn', prompt('turn-2'))
  // parts.js:774 re-delivers held input through send(); the first item is the
  // only one allowed to wake the driver.
  agent.send(prompt('wake'), 'next-turn', true)
  await agent.whenIdle()

  // The first step claims every next-step message plus the single queued turn;
  // the driver then keeps looping and gives each leftover turn message its own.
  assert.deepEqual(claimed, [
    ['step-1', 1], ['step-2', 1], ['turn-1', 1],
    ['turn-2', 2],
    ['wake', 3],
  ])
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.deepEqual(agent.inbox.nextTurn, [])
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data), [
    { turn: 1 }, { turn: 2 }, { turn: 3 },
  ])
  assert.equal(agent.status, 'idle')
})

test('agent.followup queues a next-turn message, wakes the driver, and claims it before returning', async t => {
  const { agent } = await openAgent(t, 'followup-claim')
  const inserted = []
  agent.ctx.on('agent/inbox/inserted', ({ message }) => inserted.push(message.content[0].text))
  agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => inserted.push([`claimed:${message.content[0].text}`, turn]))

  agent.followup(prompt('solo'))
  // The wake runs the driver synchronously up to its first await, so the
  // message has already left the inbox by the time followup() returns.
  assert.equal(agent.status, 'running')
  assert.deepEqual(agent.inbox.nextTurn, [])
  assert.deepEqual(inserted, ['solo', ['claimed:solo', 1]])

  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data), [{ turn: 1 }])
  assert.deepEqual(agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content[0].text), ['solo'])
})

test('agent.followup gives every message its own turn and keeps the durable user message', async t => {
  const { agent } = await openAgent(t, 'followup-turns')
  agent.followup(prompt('one'))
  agent.followup(prompt('two'))
  await agent.whenIdle()

  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data), [{ turn: 1 }, { turn: 2 }])
  assert.deepEqual(agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content[0].text), ['one', 'two'])
  assert.deepEqual(agent.inbox.nextTurn, [])
  // The durable user/message keeps the identity and source the caller supplied.
  const logged = agent.session.snapshotEvents().find(event => event.type === 'user/message').data
  assert.equal(logged.source.kind, 'user')
  assert.equal(typeof logged.id, 'string')
})

test('agent.cancel discards pending inbox work unless keepInbox preserves it', async t => {
  const { agent } = await openAgent(t, 'followup-cancel')
  agent.inbox.prepend('next-step', prompt('parked'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])

  agent.cancel({ kind: 'user' })
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.deepEqual(agent.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .map(event => event.data.outcome), [undefined, 'canceled'])
})

test('agent.ctx is an agent-scoped Context whose tool restriction does not reach the root', async t => {
  const { ctx, agent } = await openAgent(t, 'ctx-restrict')
  const other = (await ctx.agents.create({
    sessionId: SessionId('ctx-restrict-other'),
    meta: { cwd: 'C:\\contract' },
    agentOptions: { provider: 'contract', model: 'contract-1' },
  })).agent
  ctx.tools.register(defineTool({
    name: 'contract_probe',
    description: 'probe',
    parameters: {},
    output: TOOL_OUTPUT,
    async execute() { return 'done' },
  }))
  const namesOf = scope => ctx.tools.schemas(scope).map(schema => schema.name)
  assert.deepEqual(namesOf(), ['contract_probe'])
  assert.deepEqual(namesOf(agent), ['contract_probe'])

  const lift = agent.ctx.tools.restrict({ deny: ['contract_probe'] })
  assert.equal(typeof lift, 'function')
  // agents.js:56-61 relies on this: the deny is scoped to one agent.
  assert.deepEqual(namesOf(agent), [])
  assert.deepEqual(namesOf(), ['contract_probe'])
  assert.deepEqual(namesOf(other), ['contract_probe'])

  lift()
  assert.deepEqual(namesOf(agent), ['contract_probe'])
  // agents.js:49 only denies names the profile serves, because an unknown name throws.
  assert.throws(() => agent.ctx.tools.restrict({ deny: ['contract_absent'] }), /unknown global tool/u)
})

test('agent.ctx tears its contributions down with the agent and then refuses new ones', async t => {
  const { agent, dispose } = await openAgent(t, 'ctx-teardown')
  let torn = 0
  agent.ctx.effect(() => () => { torn += 1 }, 'ds-bot: contract teardown')
  const child = { name: 'contract-child', apply() {} }
  await agent.ctx.plugin(child)
  assert.equal(torn, 0)

  await dispose()
  assert.equal(torn, 1)
  assert.throws(() => agent.ctx.effect(() => () => {}), /inactive context/u)
  assert.throws(() => agent.ctx.plugin({ name: 'contract-late', apply() {} }), /inactive context/u)
})

test('agent.ctx listeners are scope-filtered to their own agent', async t => {
  const { ctx, agent } = await openAgent(t, 'ctx-scope')
  const other = (await ctx.agents.create({
    sessionId: SessionId('ctx-scope-other'),
    meta: { cwd: 'C:\\contract' },
    agentOptions: { provider: 'contract', model: 'contract-1' },
  })).agent
  const own = []
  const foreign = []
  agent.ctx.on('agent/status', ({ status }) => own.push(status))
  other.ctx.on('agent/status', ({ status }) => foreign.push(status))

  other.followup(prompt('theirs'))
  await other.whenIdle()
  assert.deepEqual(own, [])
  assert.deepEqual(foreign, ['running', 'idle'])
  assert.equal(ctx.agents.get(agent.id) !== undefined, true)
  assert.equal(ctx.agents.get(other.id) !== undefined, true)
})

test('session.append returns the committed event and grows seq by exactly one', async t => {
  const { agent } = await openAgent(t, 'append-commit')
  const session = agent.session
  assert.equal(session.seq, 0)

  const event = session.append('turn/start', { turn: 1 })
  assert.equal(event.type, 'turn/start')
  assert.equal(event.seq, 0)
  assert.equal(typeof event.time, 'number')
  assert.equal(session.seq, 1)
  assert.equal(session.eventAt(0), event)

  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(session.seq, 2)
  assert.equal(session.eventAt(session.seq - 1).type, 'turn/end')
})

test('session.append enforces the surface-op contract on both sides', async t => {
  const { agent } = await openAgent(t, 'append-surface')
  const session = agent.session
  const user = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, id: 'u-1' }

  // A message-producing event must declare how it joins the surface.
  assert.throws(() => session.append('user/message', user), /surfaceOp/u)
  // A log-only event must not carry one.
  assert.throws(() => session.append('turn/start', { turn: 1 }, { surfaceOp: 'append' }), /not surface-eligible/u)
  // An omitted source list is allowed; an explicitly empty one is not.
  assert.throws(() => session.append('user/message', user, { surfaceOp: 'append', sourceEventSeqs: [] }), /sourceEventSeqs must not be empty/u)
  assert.equal(session.append('user/message', user, { surfaceOp: 'append' }).seq, 0)
  assert.equal(session.seq, 1)
})

test('session.append accepts image/offload only where its projection is registered', async t => {
  const bare = await openAgent(t, 'offload-missing')
  bare.agent.followup(prompt('with image'))
  await bare.agent.whenIdle()
  const missing = bare.agent.session.snapshotEvents().find(event => event.type === 'user/message').seq
  const logBefore = bare.agent.session.seq
  // images.js:199 checks exactly this before appending.
  assert.equal(bare.ctx.sessions.messageProjections.some(projection => projection.type === 'image/offload'), false)
  assert.throws(
    () => bare.agent.session.append('image/offload', { targets: [{ seq: missing, imageIndexes: [0] }] }),
    /requires a message projection/u,
  )
  // A rejected append leaves the log untouched.
  assert.equal(bare.agent.session.seq, logBefore)

  const mounted = await openAgent(t, 'offload-present', { imageOffload: true })
  mounted.agent.followup(createUserMessage({ content: [IMAGE, { type: 'text', text: 'look' }], source: { kind: 'user' } }))
  await mounted.agent.whenIdle()
  const session = mounted.agent.session
  const userSeq = session.snapshotEvents().find(event => event.type === 'user/message').seq
  const before = session.deriveMessages().find(message => message.role === 'user')
  assert.equal(before.content[0].offloaded, undefined)

  const offload = session.append('image/offload', { targets: [{ seq: userSeq, imageIndexes: [0] }] })
  assert.equal(offload.type, 'image/offload')
  assert.equal(offload.seq, session.seq - 1)

  // The projection rewrites the derived message without changing its identity.
  const after = session.deriveMessages().find(message => message.role === 'user')
  assert.equal(after.id, before.id)
  assert.equal(after.content[0].offloaded, true)
  assert.equal(after.content[1].text, 'look')
  assert.deepEqual(session.deriveMessages().map(message => message.role), ['system', 'user', 'assistant'])
})

test('session.seq is the log length, so seq - 1 is the last committed event', async t => {
  const { ctx, agent } = await openAgent(t, 'seq-length')
  const session = agent.session
  // chat-index.js:55 reads throughSeq = Number(seq) - 1 and guards on >= 0.
  assert.equal(Number(session.seq) - 1, -1)
  agent.followup(prompt('one'))
  await agent.whenIdle()
  agent.followup(prompt('two'))
  await agent.whenIdle()

  const events = session.snapshotEvents()
  assert.equal(session.seq, events.length)
  assert.equal(events[events.length - 1].seq, session.seq - 1)
  assert.equal(session.eventAt(session.seq - 1), events[events.length - 1])
  // A session the store made on its own follows the same rule.
  const bare = ctx.sessions.create('seq-length-bare', { meta: { cwd: 'C:\\contract' } })
  assert.equal(bare.seq, 0)
  assert.equal(Number(bare.seq) - 1, -1)
})

test('session.header is a frozen record that mirrors the session identity and creation cwd', async t => {
  const { agent } = await openAgent(t, 'header-record')
  const session = agent.session
  assert.equal(session.header.version, 4)
  assert.equal(session.header.id, session.id)
  assert.equal(agent.id, session.id)
  assert.equal(session.header.cwd, 'C:\\contract')
  assert.equal(session.header.isSeeded, false)
  assert.equal(typeof session.header.createdAt, 'number')
  assert.equal(Object.isFrozen(session.header), true)
  // parts.js:991-992 and 1075 read header.cwd off a live or replaced session.
  assert.throws(() => { session.header.cwd = 'C:\\elsewhere' }, /read only/u)
})

test('session.requestHeader is undefined until a header event and then folds to the newest one', async t => {
  const { agent } = await openAgent(t, 'request-header')
  const session = agent.session
  assert.equal(session.requestHeader(), undefined)

  agent.followup(prompt('ask'))
  await agent.whenIdle()
  const logged = session.requestHeader()
  assert.deepEqual(logged.config, { provider: 'contract', model: 'contract-1' })
  assert.equal(logged.tools, undefined)
  // parts.js:425 and btw.js:143 read it per step, so it must stay a cached value.
  assert.equal(session.requestHeader(), logged)

  session.append('request/header', {
    header: { config: { provider: 'contract', model: 'contract-1', maxTokens: 32 }, tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] },
    reason: 'change',
  })
  const folded = session.requestHeader()
  assert.deepEqual(folded.config, { provider: 'contract', model: 'contract-1', maxTokens: 32 })
  assert.deepEqual(folded.tools.map(tool => tool.name), ['t'])
  assert.equal(session.requestHeader(), folded)
})

test('session.deriveMessages returns fresh arrays of shared frozen messages', async t => {
  const { agent } = await openAgent(t, 'derive-messages')
  const session = agent.session
  assert.deepEqual(session.deriveMessages(), [])

  agent.followup(prompt('hello'))
  await agent.whenIdle()
  const first = session.deriveMessages()
  assert.deepEqual(first.map(message => message.role), ['system', 'user', 'assistant'])

  // A later append must not grow an array a caller already holds.
  agent.followup(prompt('again'))
  await agent.whenIdle()
  const second = session.deriveMessages()
  assert.equal(first.length, 3)
  // system + user + assistant, then the second turn's user + assistant.
  assert.deepEqual(second.map(message => message.role), ['system', 'user', 'assistant', 'user', 'assistant'])
  assert.equal(first[0], second[0])
  assert.equal(Object.isFrozen(second[0]), true)
  assert.equal(Object.isFrozen(second[0].content), true)
  assert.equal(Object.isFrozen(second[0].content[0]), true)
})

test('session.deriveMessages follows a surface replacement instead of the raw log', async t => {
  const { agent } = await openAgent(t, 'derive-replace')
  const session = agent.session
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' }, id: 'r-1' }, { surfaceOp: 'append' })
  assert.deepEqual(session.deriveMessages().map(message => message.content[0].text), ['first'])

  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' }, id: 'r-2' }, {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [0],
  })
  // parts.js:428/501/910 and btw.js:144 read derived history, so a compaction
  // replace has to show through it while the log keeps both events.
  assert.deepEqual(session.deriveMessages().map(message => message.content[0].text), ['second'])
  assert.equal(session.seq, 2)
  assert.deepEqual(session.snapshotEvents().map(event => event.data?.id), ['r-1', 'r-2'])
})

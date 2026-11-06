// Behavior locks for the DSH event face and middleware order — the C0.2 contract item
// "事件面与中间件顺序" (docs/dev/2026-10-27-c0-execution-baseline.md §三 C0.2, item 2). Everything
// here runs against the real packages `npm run harness` installs in dev/harness: the cordis
// Context, ToolRuntime, SystemPrompt, LlmRuntime, SessionStore and ApprovalService are the ones
// the plugin meets at run time, and the only fakes are the tool and the LLM adapter they
// dispatch to. `npm test` does not pick this file up (it globs test/*.test.js); run it with
//   node --import ./test/harness-resolve.mjs --test dev/contract/events.test.js
//
// Six of the 16 names are driven through a real emitter here: llm/stream, tools/execute,
// system-prompt/assemble, approval/request, session/event and llm/adapters-updated. The other
// ten need a live Agent (agent/created, agent/status, agent/pre-step, agent/request-error,
// agent/assistant-stream, agent/inbox/discarded) or a service this file does not mount
// (credentials/*, settings/document-updated, deepseek-account/signed-out), so for those only the
// bus-level registration and dispatch is locked; their per-event dispatch mode is not.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'

// The host's 16 event names: 11 core (docs/dev/c0-dsh-dependency-inventory.md §三 事件依赖) plus
// the 5 optional ones models.js:20 registers in a loop — together the "11 核心 + 5 可选" of the
// C0 baseline §2.2.
const CORE_EVENTS = [
  'llm/stream',
  'session/event',
  'agent/created',
  'agent/status',
  'agent/pre-step',
  'agent/request-error',
  'tools/execute',
  'approval/request',
  'system-prompt/assemble',
  'agent/assistant-stream',
  'agent/inbox/discarded',
]
const OPTIONAL_EVENTS = [
  'llm/adapters-updated',
  'credentials/reference-updated',
  'credentials/record-updated',
  'settings/document-updated',
  'deepseek-account/signed-out',
]

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const echoTool = () => defineTool({
  name: 'echo',
  description: 'Say the text back.',
  parameters: { text: { type: 'string', description: 'What to say.' } },
  output,
  async execute(args) { return `echo:${args.text}` },
})
const execute = (ctx, name, args) => ctx.tools.execute({
  signal: new AbortController().signal,
  callId: ToolCallId(name),
  name,
  arguments: args,
})
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

// An adapter whose stream is three fixed chunks, so a `llm/stream` chain can be followed
// end to end without a provider.
class ContractAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: provider } }
  async listModels() { return ['contract-1'] }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Contract' } }
  async prepareCall(provider, model) {
    return {
      model: { provider, id: model, name: 'Contract' },
      stream: async function* contractStream() {
        yield { type: 'text-delta', index: 0, text: 'a' }
        yield { type: 'text-delta', index: 0, text: 'b' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }
}
const streamOptions = () => ({
  provider: 'contract',
  model: 'contract-1',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
  signal: new AbortController().signal,
})

test('ctx.on keeps registration order and ctx.emit follows it, across plugins', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  const first = inner => { inner.on('agent/status', () => order.push('first')) }
  const second = inner => { inner.on('agent/status', () => order.push('second')) }
  const third = inner => { inner.on('agent/status', () => order.push('third')) }
  await ctx.plugin(first)
  await ctx.plugin(second)
  await ctx.plugin(third)
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['first', 'second', 'third'])
})

test('{prepend: true} moves a listener ahead of every listener already on the event, including an earlier plugin\'s', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  const early = inner => { inner.on('agent/status', () => order.push('early')) }
  const later = inner => {
    inner.on('agent/status', () => order.push('later-default'))
    inner.on('agent/status', () => order.push('later-prepend'), { prepend: true })
  }
  await ctx.plugin(early)
  await ctx.plugin(later)
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['later-prepend', 'early', 'later-default'])
})

test('every further prepend lands ahead of the previous one, and default listeners stay behind them all', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  ctx.on('agent/status', () => order.push('default-1'))
  ctx.on('agent/status', () => order.push('prepend-1'), { prepend: true })
  ctx.on('agent/status', () => order.push('default-2'))
  ctx.on('agent/status', () => order.push('prepend-2'), { prepend: true })
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['prepend-2', 'prepend-1', 'default-1', 'default-2'])
})

test('a waterfall runs the first-registered listener outermost and composes return values outward', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  ctx.on('agent/pre-step', async (payload, next) => {
    order.push('first-in')
    const decision = await next()
    order.push('first-out')
    return { ...decision, first: true }
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    order.push('second-in')
    const decision = await next()
    order.push('second-out')
    return { ...decision, second: true }
  })
  const decision = await ctx.waterfall('agent/pre-step', { step: 1 }, () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(order, ['first-in', 'second-in', 'second-out', 'first-out'])
  assert.deepEqual(decision, { kind: 'enter', messages: [], first: true, second: true })
})

test('a listener that never calls next() consumes the event: the rest of the chain and the built-in behavior never run', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  ctx.on('agent/pre-step', async () => { order.push('outermost'); return { kind: 'reject' } })
  ctx.on('agent/pre-step', async (payload, next) => { order.push('inner'); return next() })
  const decision = await ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  })
  assert.deepEqual(order, ['outermost'])
  assert.deepEqual(decision, { kind: 'reject' })
})

test('a listener that mutates the payload changes what the inner listeners and the built-in behavior see', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const seen = []
  ctx.on('agent/pre-step', async (payload, next) => {
    payload.messages = [...payload.messages, 'added-by-outer']
    return next()
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    seen.push([...payload.messages])
    return next()
  })
  const decision = await ctx.waterfall('agent/pre-step', { messages: ['claimed'] }, (payload) => {
    // The built-in behavior sees the same payload object the listeners mutated.
    seen.push([...payload.messages])
    return { kind: 'enter', messages: ['built-in'] }
  })
  assert.deepEqual(seen, [['claimed', 'added-by-outer'], ['claimed', 'added-by-outer']])
  assert.deepEqual(decision, { kind: 'enter', messages: ['built-in'] })
})

test('await next() waits for the whole inner chain before the outer listener goes on', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  ctx.on('agent/pre-step', async (payload, next) => {
    order.push('outer-before')
    const decision = await next()
    order.push(`outer-after:${decision.kind}`)
    return decision
  })
  ctx.on('agent/pre-step', async () => {
    order.push('inner-start')
    await tick()
    order.push('inner-end')
    return { kind: 'enter', messages: [] }
  })
  const decision = await ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(order, ['outer-before', 'inner-start', 'inner-end', 'outer-after:enter'])
  assert.equal(decision.kind, 'enter')
})

test('a throw inside the chain reaches the outer listener\'s await next(), which can recover from it', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  ctx.on('agent/pre-step', async (payload, next) => {
    order.push('outer-in')
    try {
      return await next()
    } catch (error) {
      order.push(`outer-caught:${error.message}`)
      return { kind: 'reject', recovered: true }
    }
  })
  ctx.on('agent/pre-step', async () => { throw new Error('deep') })
  const decision = await ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(order, ['outer-in', 'outer-caught:deep'])
  assert.deepEqual(decision, { kind: 'reject', recovered: true })
})

test('an unrecovered throw inside a waterfall rejects the dispatch', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.on('agent/pre-step', async (payload, next) => next())
  ctx.on('agent/pre-step', async () => { throw new Error('deep') })
  await assert.rejects(ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter', messages: [] })), /deep/u)
})

test('ctx.emit does not await listeners: a synchronous throw escapes and stops the rest, and a slow listener is still running when the dispatch returns', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  ctx.on('session/event', () => { throw new Error('sync-boom') })
  ctx.on('session/event', () => order.push('after-sync'))
  assert.throws(() => ctx.emit('session/event', {}, {}), /sync-boom/u)
  assert.deepEqual(order, [])

  // Nothing awaits the listeners, so a rejection after an await would have no owner either.
  // That is why the real dispatch paths (see the session/event test) contain listener errors
  // themselves instead of leaving them to the dispatcher.
  ctx.on('agent/inbox/discarded', async () => { await tick(); order.push('slow-done') })
  ctx.on('agent/inbox/discarded', () => order.push('fast'))
  ctx.emit('agent/inbox/discarded', { message: {} })
  assert.deepEqual(order, ['fast'])
  await tick()
  assert.deepEqual(order, ['fast', 'slow-done'])
})

test('every one of the host\'s 16 event names registers on a real Context, and a name nothing listens on dispatches to nobody', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fired = []
  const disposers = [...CORE_EVENTS, ...OPTIONAL_EVENTS].map(name => {
    const dispose = ctx.on(name, () => { fired.push(name) })
    assert.equal(typeof dispose, 'function', `${name} should hand back a disposer`)
    return dispose
  })
  // No event name is validated: a bare Context has no emitter for any of them, yet each
  // registration is accepted and a dispatch reaches the listener.
  for (const name of [...CORE_EVENTS, ...OPTIONAL_EVENTS]) ctx.emit(name, {})
  assert.equal(fired.length, 16)
  for (const dispose of disposers) dispose()
  ctx.emit('llm/stream', {})
  assert.equal(fired.length, 16)

  // With nobody left on the event, a waterfall falls through to its built-in behavior and
  // the notification modes have nobody to call.
  assert.equal(ctx.bail('agent/created', { agent: {} }), undefined)
  assert.equal(await ctx.serial('agent/status', { status: 'idle' }), undefined)
  assert.deepEqual(await ctx.waterfall('agent/pre-step', { step: 1 }, () => ({ kind: 'enter' })), { kind: 'enter' })
})

test('the host\'s registration pattern on a minimal plugin set: prepend wraps, MODULES order holds inside, and a hard-line switch stops the chain', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  let switchPart = false
  let innerReject = false
  // index.js MODULES installs timeContext before parts; both listen on agent/pre-step with
  // prepend, so the later of the two (parts) ends up outermost and runs first.
  const timeContext = inner => {
    inner.on('agent/pre-step', async (payload, next) => {
      order.push('time-context')
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...decision.messages, 'clock'] }
    }, { prepend: true })
  }
  const parts = inner => {
    inner.on('agent/pre-step', async (payload, next) => {
      order.push('parts')
      // parts.js:1047 answers {kind: 'reject'} when a part is past its hard line and moves to
      // a fresh one.
      if (switchPart) return { kind: 'reject' }
      const decision = await next()
      order.push(`parts-after:${decision.kind}`)
      return decision
    }, { prepend: true })
  }
  const turns = inner => { inner.on('agent/pre-step', async (payload, next) => { order.push('turns'); return innerReject ? { kind: 'reject' } : next() }) }
  const usage = inner => { inner.on('agent/pre-step', async (payload, next) => { order.push('usage'); return next() }) }
  for (const plugin of [timeContext, parts, turns, usage]) await ctx.plugin(plugin)

  const enter = await ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  })
  // Both prepends land ahead of the default listeners, and the one registered later (parts)
  // is the outermost of the two, exactly as index.js MODULES order plus prepend gives.
  assert.deepEqual(order, ['parts', 'time-context', 'turns', 'usage', 'built-in', 'parts-after:enter'])
  assert.equal(enter.messages.at(-1), 'clock')

  // parts.js:1047 answers {kind: 'reject'} when a part is past its hard line and moves to a
  // fresh one. parts is the outermost listener, so nothing inside it runs at all.
  order.length = 0
  switchPart = true
  assert.deepEqual(await ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  }), { kind: 'reject' })
  assert.deepEqual(order, ['parts'])

  // A rejection from further in still reaches both prepended listeners: time-context passes
  // it on untouched, and parts records the kind it got back.
  order.length = 0
  switchPart = false
  innerReject = true
  assert.deepEqual(await ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  }), { kind: 'reject' })
  assert.deepEqual(order, ['parts', 'time-context', 'turns', 'parts-after:reject'])
})

test('tools/execute on a real ToolRuntime: prepend runs outermost, default order follows, and the chain unwinds in reverse', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(echoTool())
  const order = []
  const plugin = inner => {
    inner.on('tools/execute', async (exec, next) => {
      order.push(`A-in:${exec.name}`)
      const result = await next()
      order.push(`A-out:${result.isError}`)
      return result
    })
    inner.on('tools/execute', async (exec, next) => { order.push('B-in'); const result = await next(); order.push('B-out'); return result })
    inner.on('tools/execute', async (exec, next) => { order.push('P-in'); return next() }, { prepend: true })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const result = await execute(ctx, 'echo', { text: 'hi' })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(result.value, 'echo:hi')
  assert.deepEqual(order, ['P-in', 'A-in:echo', 'B-in', 'B-out', 'A-out:false'])
})

test('a tools/execute middleware rewrite reaches the tool body, and a veto keeps the body from running', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(echoTool())
  const order = []
  const rewriter = inner => {
    inner.on('tools/execute', async (exec, next) => { order.push('rewrite'); exec.arguments = { text: 'rewritten' }; return next() })
  }
  rewriter.inject = ['tools']
  await ctx.plugin(rewriter)
  assert.equal((await execute(ctx, 'echo', { text: 'hi' })).value, 'echo:rewritten')
  assert.deepEqual(order, ['rewrite'])

  const vetoer = inner => {
    // A middleware's return value goes through the tool's own output validation, so a veto
    // answers with a result-shaped object, as secrets.js:489 does.
    inner.on('tools/execute', async () => { order.push('veto'); return { isError: false, value: 'blocked' } }, { prepend: true })
  }
  vetoer.inject = ['tools']
  await ctx.plugin(vetoer)
  const vetoed = await execute(ctx, 'echo', { text: 'hi' })
  assert.equal(vetoed.isError, false, vetoed.error?.message)
  assert.equal(vetoed.value, 'blocked')
  assert.deepEqual(order, ['rewrite', 'veto'])
})

test('a throwing tools/execute middleware becomes a structured tool error rather than a rejected execute()', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(echoTool())
  const order = []
  const plugin = inner => {
    inner.on('tools/execute', async (exec, next) => { order.push('outer-in'); const result = await next(); order.push('outer-out'); return result })
    inner.on('tools/execute', async () => { order.push('thrower'); throw new Error('middleware-boom') })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const result = await execute(ctx, 'echo', { text: 'hi' })
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'middleware-boom')
  // The throw left the chain at the throwing listener, so the listener outside it never unwound.
  assert.deepEqual(order, ['outer-in', 'thrower'])
})

test('an unknown tool still runs the tools/execute chain and hands its structured error back through it', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(echoTool())
  const order = []
  const plugin = inner => {
    inner.on('tools/execute', async (exec, next) => { order.push('in'); const result = await next(); order.push(`out:${result.isError}`); return result })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const result = await execute(ctx, 'nope', {})
  assert.equal(result.isError, true)
  assert.match(result.error.message, /unknown tool "nope"/u)
  assert.deepEqual(order, ['in', 'out:true'])
})

test('system-prompt/assemble on a real SystemPrompt: the outermost listener\'s return value is the assembly DSH uses', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  const order = []
  const plugin = inner => {
    inner.on('system-prompt/assemble', async (assembly, context, next) => { order.push('A'); const out = await next(); return { ...out, a: 1 } })
    inner.on('system-prompt/assemble', async (assembly, context, next) => { order.push('B'); const out = await next(); return { ...out, b: 1 } })
    // parts.js:1092 takes the working folder out of `context.agent` this way, then calls next().
    inner.on('system-prompt/assemble', async (assembly, context, next) => { order.push('P'); const out = await next(); return { ...out, p: 1 } }, { prepend: true })
  }
  await ctx.plugin(plugin)
  const assembly = await ctx.systemPrompt.assemble({})
  assert.deepEqual(order, ['P', 'A', 'B'])
  assert.deepEqual([assembly.a, assembly.b, assembly.p], [1, 1, 1])
  assert.ok(assembly.sections.some(section => section.name === 'harness:identity'))
})

test('a system-prompt/assemble veto replaces the whole assembly without running the inner listeners', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  const order = []
  const plugin = inner => {
    inner.on('system-prompt/assemble', async (assembly, context, next) => { order.push('A'); return next() })
    inner.on('system-prompt/assemble', async () => {
      order.push('veto')
      return { sections: [{ name: 'only-mine', text: 'mine' }], contexts: [], tools: [], variables: {} }
    }, { prepend: true })
  }
  await ctx.plugin(plugin)
  const assembly = await ctx.systemPrompt.assemble({})
  assert.deepEqual(order, ['veto'])
  assert.deepEqual(assembly.sections.map(section => section.name), ['only-mine'])
})

test('llm/stream on a real LlmRuntime: prepend runs first and a veto replaces the adapter stream', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const order = []
  const plugin = inner => {
    inner.on('llm/stream', (options, next) => {
      order.push('A-in')
      return (async function* pass() {
        for await (const chunk of next()) { order.push(`A:${chunk.type}`); yield chunk }
      })()
    })
    inner.on('llm/stream', (options, next) => { order.push('P-in'); return next() }, { prepend: true })
  }
  await ctx.plugin(plugin)
  ctx.llm.registerAdapter(['contract'], new ContractAdapter())
  const chunks = []
  for await (const chunk of ctx.llm.stream(streamOptions())) chunks.push(chunk.type)
  assert.deepEqual(chunks, ['text-delta', 'text-delta', 'finish'])
  assert.deepEqual(order, ['P-in', 'A-in', 'A:text-delta', 'A:text-delta', 'A:finish'])

  const vetoer = inner => {
    inner.on('llm/stream', () => {
      order.push('veto')
      return (async function* mine() {
        yield { type: 'text-delta', index: 0, text: 'mine' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, { prepend: true })
  }
  await ctx.plugin(vetoer)
  order.length = 0
  const vetoed = []
  for await (const chunk of ctx.llm.stream(streamOptions())) vetoed.push(chunk.text ?? chunk.type)
  assert.deepEqual(vetoed, ['mine', 'finish'])
  assert.deepEqual(order, ['veto'])
})

test('a throwing llm/stream middleware surfaces to the stream consumer instead of becoming a terminal chunk', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const order = []
  const plugin = inner => {
    inner.on('llm/stream', (options, next) => { order.push('outer'); return next() })
    inner.on('llm/stream', () => { throw new Error('llm-boom') }, { prepend: true })
  }
  await ctx.plugin(plugin)
  ctx.llm.registerAdapter(['contract'], new ContractAdapter())
  await assert.rejects((async () => {
    for await (const chunk of ctx.llm.stream(streamOptions())) order.push(chunk.type)
  })(), /llm-boom/u)
  assert.deepEqual(order, [])
})

test('the outermost llm/stream listener decides the shape ctx.llm.stream() returns', async t => {
  // src/host returns an async generator from every llm/stream listener, so the stream the
  // caller gets is that generator. A listener declared `async` would wrap it in a promise.
  const generator = new Context()
  t.after(() => generator.fiber.dispose())
  await generator.plugin(LlmRuntime)
  await generator.plugin(inner => { inner.on('llm/stream', (options, next) => next()) })
  generator.llm.registerAdapter(['contract'], new ContractAdapter())
  const direct = generator.llm.stream(streamOptions())
  assert.equal(typeof direct[Symbol.asyncIterator], 'function')

  const wrapped = new Context()
  t.after(() => wrapped.fiber.dispose())
  await wrapped.plugin(LlmRuntime)
  await wrapped.plugin(inner => { inner.on('llm/stream', async (options, next) => next()) })
  wrapped.llm.registerAdapter(['contract'], new ContractAdapter())
  const promised = wrapped.llm.stream(streamOptions())
  assert.equal(typeof promised[Symbol.asyncIterator], 'undefined')
  assert.equal(typeof (await promised)[Symbol.asyncIterator], 'function')
})

test('an llm/stream payload rewrite reaches the adapter', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const seen = []
  class Watching extends ContractAdapter {
    async prepareCall(provider, model) {
      seen.push(model)
      return super.prepareCall(provider, model)
    }
  }
  await ctx.plugin(inner => { inner.on('llm/stream', (options, next) => { options.model = 'contract-2'; return next() }) })
  ctx.llm.registerAdapter(['contract'], new Watching())
  const drained = []
  for await (const chunk of ctx.llm.stream(streamOptions())) drained.push(chunk.type)
  assert.deepEqual(seen, ['contract-2'])
  assert.deepEqual(drained, ['text-delta', 'text-delta', 'finish'])
})

test('session/event on a real Session: registration order with prepend, and the event payload is frozen', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const order = []
  const plugin = inner => {
    inner.on('session/event', (session, event) => order.push(`A:${event.type}#${event.seq}`))
    inner.on('session/event', (session, event) => order.push(`B:${event.type}#${event.seq}`))
    inner.on('session/event', (session, event) => order.push(`P:${event.type}#${event.seq}`), { prepend: true })
  }
  await ctx.plugin(plugin)
  const session = ctx.sessions.create('contract-session')
  order.length = 0
  const event = session.append('plugin:contract/ping', { note: 'hi' })
  assert.deepEqual(order, ['P:plugin:contract/ping#0', 'A:plugin:contract/ping#0', 'B:plugin:contract/ping#0'])
  assert.equal(Object.isFrozen(event), true)
  assert.equal(Object.isFrozen(event.data), true)
  assert.equal(session.seq, 1)
})

test('session/event contains a throwing listener: later listeners still run and the append is unaffected', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const warnings = []
  ctx.logger = { warn: (...args) => warnings.push(args.map(String).join(' ')), info() {} }
  const order = []
  const plugin = inner => {
    inner.on('session/event', () => order.push('first'))
    inner.on('session/event', () => { throw new Error('sync-boom') })
    inner.on('session/event', async () => { await tick(); throw new Error('async-boom') })
    inner.on('session/event', () => order.push('last'))
  }
  await ctx.plugin(plugin)
  const session = ctx.sessions.create('contract-session')
  order.length = 0
  const event = session.append('plugin:contract/ping', { note: 'hi' })
  assert.deepEqual(order, ['first', 'last'])
  assert.equal(event.seq, 0)
  await tick()
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /session "contract-session": session\/event listener threw: Error: sync-boom/u)
  assert.match(warnings[1], /session "contract-session": session\/event listener rejected: Error: async-boom/u)
})

test('llm/adapters-updated fires on a real adapter registration and disposal, and contains a throwing listener', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const warnings = []
  ctx.logger = { warn: (...args) => warnings.push(args.map(String).join(' ')), info() {} }
  const fired = []
  // models.js:182 registers, waits, and disposes inside one wait, so the disposer has to work.
  const plugin = inner => {
    inner.on('llm/adapters-updated', () => fired.push('plain'))
    inner.on('llm/adapters-updated', () => { throw new Error('adapters-boom') })
  }
  await ctx.plugin(plugin)
  const dispose = ctx.llm.registerAdapter(['contract'], new ContractAdapter())
  assert.deepEqual(fired, ['plain'])
  dispose()
  assert.deepEqual(fired, ['plain', 'plain'])
  assert.match(warnings.join('\n'), /an llm\/adapters-updated listener failed/u)
})

test('approval/request on a real approval service: prepend answers first, a veto skips the built-in answerer, and a throw fails closed', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  // The service only asks inside an open turn, because the ask/outcome pair has to sit
  // inside the durable log's turn boundary.
  const session = ctx.sessions.create('contract-session')
  session.append('turn/start', {})
  const agent = { id: 'contract-agent', session }
  const ask = callId => ctx.approval.request({
    agent,
    toolName: 'bash',
    reason: 'run a command',
    callId,
    signal: new AbortController().signal,
  })
  let mode = 'pass'
  const order = []
  const plugin = inner => {
    inner.on('approval/request', async (request, next) => { order.push('A-in'); const outcome = await next(); order.push('A-out'); return outcome })
    inner.on('approval/request', async (request, next) => {
      order.push('P-in')
      // approvals.js:48 answers a group Session from its card this way instead of letting
      // DSH's own answerer hold the request unseen.
      if (mode === 'answer') return 'allowed-once'
      if (mode === 'throw') throw new Error('answerer-boom')
      return next()
    }, { prepend: true })
  }
  await ctx.plugin(plugin)
  // With no answerer at all the chain runs and the built-in behavior fails closed.
  assert.equal(await ask('call-1'), 'unavailable')
  assert.deepEqual(order, ['P-in', 'A-in', 'A-out'])

  order.length = 0
  mode = 'answer'
  assert.equal(await ask('call-2'), 'allowed-once')
  assert.deepEqual(order, ['P-in'])

  order.length = 0
  mode = 'throw'
  assert.equal(await ask('call-3'), 'unavailable')
  assert.deepEqual(order, ['P-in'])
})

test('a listener\'s disposer removes it, once fires once, and a plugin fiber\'s disposal removes its listeners', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const order = []
  const dispose = ctx.on('agent/status', () => order.push('disposable'))
  ctx.emit('agent/status', { status: 'idle' })
  dispose()
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['disposable'])

  ctx.once('agent/inbox/discarded', () => order.push('once'))
  ctx.emit('agent/inbox/discarded', { message: {} })
  ctx.emit('agent/inbox/discarded', { message: {} })
  assert.deepEqual(order, ['disposable', 'once'])

  const fiber = await ctx.plugin(inner => {
    inner.on('agent/status', () => order.push('fiber'))
    inner.on('agent/pre-step', (payload, next) => { order.push('fiber-waterfall'); return next() })
  })
  ctx.emit('agent/status', { status: 'idle' })
  await ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter' }))
  await fiber.dispose()
  ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(await ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter' })), { kind: 'enter' })
  assert.deepEqual(order, ['disposable', 'once', 'fiber', 'fiber-waterfall'])
})

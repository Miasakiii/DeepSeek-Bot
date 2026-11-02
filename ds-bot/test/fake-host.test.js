// fake-host 的语义锁定：fake 的每个行为至少一条断言，注释引用钉住同一语义的行为锁定测试
// （dev/contract/<file>:<line>，对 dev/harness 里的真实包实测）。本文件与锁测试同构——锁测试
// 断言 DSH 真实行为，这里断言 fake 复刻了它；将来 L2 迁移只换供给不改断言，两边必须同时成立。
// 不 import 任何 @deepseek-ai/*（scripts/check-dsh-imports.mjs 连 test/ 一起扫）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeAgent, fakeHost, fakeRuntime, fakeSession, isUnloaded, HOST_CONTRACT } from './fake-host.js'

const prompt = text => ({ id: `m-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const tool = (name, execute) => ({
  name,
  description: `${name} tool`,
  parameters: { text: { type: 'string', description: 'What to say.' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  execute,
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// 一个带 warn 收集的 host：容纳监听错误的分发把错误送进 logger.warn（events.test.js:581-604）。
const noisyHost = warnings => fakeHost({ logger: { warn: (...args) => warnings.push(args.join(' ')), info() {} } })

// ============================================================================
// 1. 事件总线与中间件顺序（dev/contract/events.test.js）
// ============================================================================

test('ctx.on keeps registration order and ctx.emit follows it, across plugins', async () => {
  const host = fakeHost()
  const order = []
  const first = inner => { inner.on('agent/status', () => order.push('first')) }
  const second = inner => { inner.on('agent/status', () => order.push('second')) }
  const third = inner => { inner.on('agent/status', () => order.push('third')) }
  await host.ctx.plugin(first)
  await host.ctx.plugin(second)
  await host.ctx.plugin(third)
  host.ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['first', 'second', 'third'])
  await host.dispose()
})

test('{prepend: true} moves a listener ahead of every listener already on the event, including an earlier plugin\'s', async () => {
  const host = fakeHost()
  const order = []
  const early = inner => { inner.on('agent/status', () => order.push('early')) }
  const later = inner => {
    inner.on('agent/status', () => order.push('later-default'))
    inner.on('agent/status', () => order.push('later-prepend'), { prepend: true })
  }
  await host.ctx.plugin(early)
  await host.ctx.plugin(later)
  host.ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['later-prepend', 'early', 'later-default'])
  await host.dispose()
})

test('every further prepend lands ahead of the previous one, and default listeners stay behind them all', () => {
  const host = fakeHost()
  const order = []
  host.ctx.on('agent/status', () => order.push('default-1'))
  host.ctx.on('agent/status', () => order.push('prepend-1'), { prepend: true })
  host.ctx.on('agent/status', () => order.push('default-2'))
  host.ctx.on('agent/status', () => order.push('prepend-2'), { prepend: true })
  host.ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['prepend-2', 'prepend-1', 'default-1', 'default-2'])
})

test('a waterfall runs the first-registered listener outermost and composes return values outward', async () => {
  const host = fakeHost()
  const order = []
  host.ctx.on('agent/pre-step', async (payload, next) => {
    order.push('first-in')
    const decision = await next()
    order.push('first-out')
    return { ...decision, first: true }
  })
  host.ctx.on('agent/pre-step', async (payload, next) => {
    order.push('second-in')
    const decision = await next()
    order.push('second-out')
    return { ...decision, second: true }
  })
  const decision = await host.ctx.waterfall('agent/pre-step', { step: 1 }, () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(order, ['first-in', 'second-in', 'second-out', 'first-out'])
  assert.deepEqual(decision, { kind: 'enter', messages: [], first: true, second: true })
})

test('a listener that never calls next() consumes the event: the rest of the chain and the built-in behavior never run', async () => {
  const host = fakeHost()
  const order = []
  host.ctx.on('agent/pre-step', async () => { order.push('outermost'); return { kind: 'reject' } })
  host.ctx.on('agent/pre-step', async (payload, next) => { order.push('inner'); return next() })
  const decision = await host.ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  })
  assert.deepEqual(order, ['outermost'])
  assert.deepEqual(decision, { kind: 'reject' })
})

test('a listener that mutates the payload changes what the inner listeners and the built-in behavior see', async () => {
  const host = fakeHost()
  const seen = []
  host.ctx.on('agent/pre-step', async (payload, next) => {
    payload.messages = [...payload.messages, 'added-by-outer']
    return next()
  })
  host.ctx.on('agent/pre-step', async (payload, next) => {
    seen.push([...payload.messages])
    return next()
  })
  const decision = await host.ctx.waterfall('agent/pre-step', { messages: ['claimed'] }, payload => {
    seen.push([...payload.messages])
    return { kind: 'enter', messages: ['built-in'] }
  })
  assert.deepEqual(seen, [['claimed', 'added-by-outer'], ['claimed', 'added-by-outer']])
  assert.deepEqual(decision, { kind: 'enter', messages: ['built-in'] })
})

test('await next() waits for the whole inner chain before the outer listener goes on', async () => {
  const host = fakeHost()
  const order = []
  host.ctx.on('agent/pre-step', async (payload, next) => {
    order.push('outer-before')
    const decision = await next()
    order.push(`outer-after:${decision.kind}`)
    return decision
  })
  host.ctx.on('agent/pre-step', async () => {
    order.push('inner-start')
    await sleep(5)
    order.push('inner-end')
    return { kind: 'enter', messages: [] }
  })
  const decision = await host.ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(order, ['outer-before', 'inner-start', 'inner-end', 'outer-after:enter'])
  assert.equal(decision.kind, 'enter')
})

test('a throw inside the chain reaches the outer listener\'s await next(), which can recover from it', async () => {
  const host = fakeHost()
  const order = []
  host.ctx.on('agent/pre-step', async (payload, next) => {
    order.push('outer-in')
    try {
      return await next()
    } catch (error) {
      order.push(`outer-caught:${error.message}`)
      return { kind: 'reject', recovered: true }
    }
  })
  host.ctx.on('agent/pre-step', async () => { throw new Error('deep') })
  const decision = await host.ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(order, ['outer-in', 'outer-caught:deep'])
  assert.deepEqual(decision, { kind: 'reject', recovered: true })
})

test('an unrecovered throw inside a waterfall rejects the dispatch', async () => {
  const host = fakeHost()
  host.ctx.on('agent/pre-step', async (payload, next) => next())
  host.ctx.on('agent/pre-step', async () => { throw new Error('deep') })
  await assert.rejects(host.ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter', messages: [] })), /deep/u)
})

test('ctx.emit does not await listeners: a synchronous throw escapes and stops the rest, and a slow listener is still running when the dispatch returns', async () => {
  const host = fakeHost()
  const order = []
  host.ctx.on('session/event', () => { throw new Error('sync-boom') })
  host.ctx.on('session/event', () => order.push('after-sync'))
  assert.throws(() => host.ctx.emit('session/event', {}, {}), /sync-boom/u)
  assert.deepEqual(order, [])

  host.ctx.on('agent/inbox/discarded', async () => { await sleep(5); order.push('slow-done') })
  host.ctx.on('agent/inbox/discarded', () => order.push('fast'))
  host.ctx.emit('agent/inbox/discarded', { message: {} })
  assert.deepEqual(order, ['fast'])
  await sleep(10)
  assert.deepEqual(order, ['fast', 'slow-done'])
})

test('emit hands the payload arguments to a listener as they are: two parameters are two payload arguments, not a middleware next', () => {
  // host.js §2 EventBus.on 注：监听器形参个数不决定形态，分发模式由发射方选——session/event 的
  // 四例 src/host 监听正是 (session, event) 两参（events.test.js:567-575 同款用法并通过）。
  const host = fakeHost()
  const seen = []
  host.ctx.on('session/event', (session, event) => seen.push([session.id, event.type]))
  host.ctx.emit('session/event', { id: 's1' }, { type: 'plugin:contract/ping' })
  assert.deepEqual(seen, [['s1', 'plugin:contract/ping']])
})

test('every one of the host\'s 16 event names registers on the fake, and a name nothing listens on dispatches to nobody', async () => {
  const host = fakeHost()
  const fired = []
  const disposers = [...HOST_CONTRACT.events.core, ...HOST_CONTRACT.events.optional].map(name => {
    const dispose = host.ctx.on(name, () => { fired.push(name) })
    assert.equal(typeof dispose, 'function', `${name} should hand back a disposer`)
    return dispose
  })
  for (const name of [...HOST_CONTRACT.events.core, ...HOST_CONTRACT.events.optional]) host.ctx.emit(name, {})
  assert.equal(fired.length, 16)
  for (const dispose of disposers) dispose()
  host.ctx.emit('llm/stream', {})
  assert.equal(fired.length, 16)

  assert.equal(host.ctx.bail('agent/created', { agent: {} }), undefined)
  assert.equal(await host.ctx.serial('agent/status', { status: 'idle' }), undefined)
  assert.deepEqual(await host.ctx.waterfall('agent/pre-step', { step: 1 }, () => ({ kind: 'enter' })), { kind: 'enter' })
})

test('the host\'s registration pattern on a minimal plugin set: prepend wraps, MODULES order holds inside, and a hard-line switch stops the chain', async () => {
  const host = fakeHost()
  const order = []
  let switchPart = false
  let innerReject = false
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
      if (switchPart) return { kind: 'reject' }
      const decision = await next()
      order.push(`parts-after:${decision.kind}`)
      return decision
    }, { prepend: true })
  }
  const turns = inner => { inner.on('agent/pre-step', async (payload, next) => { order.push('turns'); return innerReject ? { kind: 'reject' } : next() }) }
  const usage = inner => { inner.on('agent/pre-step', async (payload, next) => { order.push('usage'); return next() }) }
  for (const plugin of [timeContext, parts, turns, usage]) await host.ctx.plugin(plugin)

  const enter = await host.ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  })
  assert.deepEqual(order, ['parts', 'time-context', 'turns', 'usage', 'built-in', 'parts-after:enter'])
  assert.equal(enter.messages.at(-1), 'clock')

  order.length = 0
  switchPart = true
  assert.deepEqual(await host.ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  }), { kind: 'reject' })
  assert.deepEqual(order, ['parts'])

  order.length = 0
  switchPart = false
  innerReject = true
  assert.deepEqual(await host.ctx.waterfall('agent/pre-step', { step: 1 }, () => {
    order.push('built-in')
    return { kind: 'enter', messages: [] }
  }), { kind: 'reject' })
  assert.deepEqual(order, ['parts', 'time-context', 'turns', 'parts-after:reject'])
})

test('a listener\'s disposer removes it, once fires once, and a plugin fiber\'s disposal removes its listeners', async () => {
  const host = fakeHost()
  const order = []
  const dispose = host.ctx.on('agent/status', () => order.push('disposable'))
  host.ctx.emit('agent/status', { status: 'idle' })
  dispose()
  host.ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(order, ['disposable'])

  host.ctx.once('agent/inbox/discarded', () => order.push('once'))
  host.ctx.emit('agent/inbox/discarded', { message: {} })
  host.ctx.emit('agent/inbox/discarded', { message: {} })
  assert.deepEqual(order, ['disposable', 'once'])

  const fiber = await host.ctx.plugin(inner => {
    inner.on('agent/status', () => order.push('fiber'))
    inner.on('agent/pre-step', (payload, next) => { order.push('fiber-waterfall'); return next() })
  })
  host.ctx.emit('agent/status', { status: 'idle' })
  await host.ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter' }))
  await fiber.dispose()
  host.ctx.emit('agent/status', { status: 'idle' })
  assert.deepEqual(await host.ctx.waterfall('agent/pre-step', {}, () => ({ kind: 'enter' })), { kind: 'enter' })
  assert.deepEqual(order, ['disposable', 'once', 'fiber', 'fiber-waterfall'])
})

// ============================================================================
// 2. effect/dispose 生命周期（dev/contract/effects.test.js）
// ============================================================================

test('ctx.effect runs its body at registration and returns a callable, thenable disposer', async () => {
  const host = fakeHost()
  const marks = []
  const first = host.ctx.effect(() => { marks.push('first'); return () => marks.push('first dispose') }, 'first')
  const second = host.ctx.effect(() => { marks.push('second'); return null }, 'second')
  const third = host.ctx.effect(() => { marks.push('third'); return undefined }, 'third')

  assert.deepEqual(marks, ['first', 'second', 'third'])
  for (const disposer of [first, second, third]) {
    assert.equal(typeof disposer, 'function')
    assert.equal(typeof disposer.then, 'function')
  }
  assert.equal(first.label, 'first')
  assert.deepEqual(host.ctx.fiber.getEffects().map(meta => meta.label), ['first', 'second', 'third'])
  await host.dispose()
  assert.deepEqual(marks, ['first', 'second', 'third', 'first dispose'])
})

test('an effect body may return nothing, and may not return a value that is not a disposer', () => {
  const host = fakeHost()
  const plain = host.ctx.effect(() => undefined)
  assert.equal(typeof plain, 'function')
  assert.equal(plain.label, 'anonymous')
  assert.throws(() => host.ctx.effect(() => 'not a disposer', 'bad'), { name: 'TypeError', message: 'Invalid effect' })
})

test('a disposer that returns a promise holds the unload open until it settles', async () => {
  const host = fakeHost()
  const marks = []
  host.ctx.effect(() => () => { marks.push('sync') }, 'sync')
  host.ctx.effect(() => async () => {
    marks.push('async start')
    await sleep(10)
    marks.push('async end')
  }, 'async')
  const task = host.dispose()
  assert.equal(typeof task.then, 'function', 'the unload settles as a promise')
  await task
  assert.deepEqual(marks, ['async start', 'sync', 'async end'])
})

test('an effect whose body returns a promise keeps the disposer that promise resolves to', async () => {
  // test/fake-ctx.js:60-68 的缺口（effects.test.js:92-102 实证）：execute() 只收直接交回的
  // disposer，经 Promise 交回的被丢掉。fake-host 补上：body 的 Promise 兑现时收取 disposer。
  const host = fakeHost()
  const marks = []
  host.ctx.effect(() => Promise.resolve().then(() => {
    marks.push('promise body')
    return () => marks.push('promise disposer')
  }), 'promise')
  host.ctx.effect(async () => {
    await Promise.resolve()
    marks.push('async body')
    return () => marks.push('async disposer')
  }, 'async body')
  await sleep(5)
  await host.dispose()
  assert.deepEqual(marks, ['promise body', 'async body', 'async disposer', 'promise disposer'])
})

test('effects are disposed in reverse registration order, all of them started before any finishes', async () => {
  const host = fakeHost()
  const marks = []
  host.ctx.effect(() => async () => {
    marks.push('slow start')
    await sleep(15)
    marks.push('slow end')
  }, 'slow')
  host.ctx.effect(() => () => marks.push('sync'), 'sync')
  host.ctx.effect(() => async () => {
    marks.push('quick start')
    await sleep(1)
    marks.push('quick end')
  }, 'quick')
  await host.dispose()
  assert.deepEqual(marks, ['quick start', 'sync', 'slow start', 'quick end', 'slow end'])
})

test("one effect's several disposers run in reverse order, one after another", async () => {
  const host = fakeHost()
  const marks = []
  host.ctx.effect(function* () {
    yield async () => {
      marks.push('first start')
      await sleep(10)
      marks.push('first end')
    }
    yield () => marks.push('second')
    yield async () => {
      marks.push('third start')
      await sleep(5)
      marks.push('third end')
    }
  }, 'chain')
  await host.dispose()
  assert.deepEqual(marks, ['third start', 'third end', 'second', 'first start', 'first end'])
})

test('the returned disposer is idempotent, detaches the effect, and awaiting it does not dispose', async () => {
  const host = fakeHost()
  const marks = []
  const counted = host.ctx.effect(() => () => { marks.push('counted') }, 'counted')
  const first = counted()
  const second = counted()
  assert.equal(first, second, 'a second call hands back the disposal already in flight')
  assert.deepEqual(marks, ['counted'])
  await host.dispose()
  assert.deepEqual(marks, ['counted'], 'an effect disposed early is not disposed again')
  assert.deepEqual(host.ctx.fiber.getEffects(), [])

  const late = fakeHost()
  const wrapper = late.ctx.effect(() => { marks.push('setup'); return () => marks.push('dispose') }, 'thenable')
  await wrapper
  assert.deepEqual(marks, ['counted', 'setup'])
  assert.deepEqual(late.ctx.fiber.getEffects().map(meta => meta.label), ['thenable'])
})

test('registering an effect after the unload fails with the inactive-context error', async () => {
  const host = fakeHost()
  let scope
  const fiber = await host.ctx.plugin(inner => {
    scope = inner
    inner.effect(() => () => {}, 'live')
  })
  assert.notEqual(fiber.uid, null)
  await fiber.dispose()
  assert.equal(fiber.uid, null)
  assert.throws(() => scope.effect(() => () => {}, 'late'), error => {
    assert.equal(error.code, 'INACTIVE_EFFECT')
    assert.equal(error.message, 'cannot create effect on inactive context')
    return true
  })
  // 该消息不含 "in inactive context"：parts.js:748 的谓词只能靠 uid === null 捕住它。
  assert.doesNotMatch('cannot create effect on inactive context', /in inactive context/u)
})

test('an effect on a nested context goes with that context, and with its parent', async () => {
  const host = fakeHost()
  const marks = []
  let outer
  await host.ctx.plugin(scope => {
    outer = scope
    scope.effect(() => () => marks.push('outer'), 'outer')
  })
  const innerFiber = await outer.plugin(scope => { scope.effect(() => () => marks.push('inner'), 'inner') })
  await innerFiber.dispose()
  assert.deepEqual(marks, ['inner'])
  assert.equal(innerFiber.uid, null)

  const nested = []
  const root = fakeHost()
  let parent
  const parentFiber = await root.ctx.plugin(scope => {
    parent = scope
    scope.effect(() => () => nested.push('parent'), 'parent')
  })
  const childFiber = await parent.plugin(scope => { scope.effect(() => () => nested.push('child'), 'child') })
  await parentFiber.dispose()
  assert.equal(childFiber.uid, null)
  assert.deepEqual(nested, ['parent', 'child'])
})

test('a throwing disposer is logged and dropped, so the other cleanups still run', async () => {
  const host = fakeHost()
  const closed = []
  host.ctx.effect(() => () => closed.push('ledger'), 'ds-bot: usage ledger')
  host.ctx.effect(() => () => closed.push('index'), 'ds-bot: chat index')
  host.ctx.effect(() => () => { throw new Error('close failed') }, 'ds-bot: throwing closer')
  await host.dispose()
  assert.deepEqual(closed, ['index', 'ledger'])
})

// ============================================================================
// 3. 服务面（dev/contract/services.test.js）
// ============================================================================

test('ctx.get answers undefined for a service nobody provided and never throws', () => {
  const host = fakeHost()
  assert.equal(typeof host.ctx.get, 'function')
  assert.equal(host.ctx.get('nothing-here'), undefined)
  assert.equal(host.ctx.get?.('nothing-here'), undefined)
  assert.equal(host.ctx.nothingHere, undefined)
  assert.equal(typeof host.ctx.inject, 'function')
  assert.equal(typeof host.ctx.plugin, 'function')
})

test('a service property read needs the inject while ctx.get reads any provided service', async () => {
  const host = fakeHost()
  await host.ctx.plugin({ name: 'alpha-provider', apply: inner => inner.provide('alpha', { marker: 'a' }) })
  await host.ctx.plugin({ name: 'beta-provider', apply: inner => inner.provide('beta', { marker: 'b' }) })
  const seen = {}
  await host.ctx.plugin({
    name: 'miasaki-dsbot-reader',
    inject: ['alpha'],
    apply(reader) {
      seen.alpha = reader.alpha
      try { void reader.beta } catch (error) { seen.betaError = error.message }
      seen.alphaGet = reader.get('alpha')
      seen.betaGet = reader.get('beta')
      seen.missingGet = reader.get('nothing-here')
    },
  })
  assert.deepEqual(seen.alpha, { marker: 'a' })
  assert.match(seen.betaError, /cannot get property "beta" without inject/u)
  assert.deepEqual(seen.alphaGet, { marker: 'a' })
  assert.deepEqual(seen.betaGet, { marker: 'b' })
  assert.equal(seen.missingGet, undefined)
})

test('ctx.inject waits for the service and attaches when it appears later', async () => {
  const host = fakeHost()
  const attached = []
  let state
  await host.ctx.plugin({
    name: 'miasaki-dsbot-inject-late',
    apply(inner) { state = inner.inject(['lateService'], sub => attached.push(sub)) },
  })
  assert.deepEqual(attached, [])
  await state.await()
  assert.deepEqual(attached, [], 'the callback has not run yet: the service is not there')

  const service = { marker: 'late' }
  await host.ctx.plugin({ name: 'late-provider', apply: inner => inner.provide('lateService', service) })
  await state.await()
  assert.equal(attached.length, 1)
  assert.equal(attached[0].lateService, service)
  assert.equal(typeof attached[0].effect, 'function')
})

test('ctx.inject never runs its callback when the service never appears, and the fiber still settles', async () => {
  const host = fakeHost()
  let ran = false
  let state
  await host.ctx.plugin({
    name: 'miasaki-dsbot-inject-never',
    apply(inner) { state = inner.inject(['never-provided'], () => { ran = true }) },
  })
  await state.await()
  assert.equal(ran, false)
})

test('ctx.inject hands the callback the provider\'s own instance, and a second injection of the same name attaches to the same instance', async () => {
  const host = fakeHost()
  const service = { marker: 'probe' }
  await host.ctx.plugin({ name: 'probe-provider', apply: inner => inner.provide('probe', service) })
  const seen = []
  let first
  let second
  await host.ctx.plugin({
    name: 'inject-first',
    apply(inner) { first = inner.inject(['probe'], sub => seen.push(sub)) },
  })
  await host.ctx.plugin({
    name: 'inject-second',
    apply(inner) { second = inner.inject(['probe'], sub => seen.push(sub)) },
  })
  await first.await()
  await second.await()
  assert.equal(seen.length, 2)
  assert.equal(seen[0].probe, service)
  assert.equal(seen[1].probe, service)
  assert.equal(host.ctx.get('probe'), service)
})

test('unloading the provider releases the attached service and clears the outer scope', async () => {
  const host = fakeHost()
  const service = { marker: 'probe' }
  const provider = await host.ctx.plugin({ name: 'probe-provider', apply: inner => inner.provide('probe', service) })
  let released = null
  let state
  await host.ctx.plugin({
    name: 'inject-probe',
    apply(inner) {
      state = inner.inject(['probe'], sub => {
        const own = sub.probe
        sub.effect(() => () => { if (own === service) released = service }, 'ds-bot: probe service')
      })
    },
  })
  await state.await()
  assert.equal(released, null)
  await provider.dispose()
  assert.equal(released, service)
  assert.equal(host.ctx.get('probe'), undefined)
})

test('a DSH-like service instance reads back as a fresh traceable proxy on every read, a plain value does not', async () => {
  const host = fakeHost()
  const first = host.ctx.get('sessionProjections')
  const second = host.ctx.get('sessionProjections')
  assert.notEqual(first, second)
  assert.notEqual(first.register, second.register)
  assert.equal(typeof first.register, 'function')
  assert.equal(typeof second.stateOf, 'function')
  const plain = { marker: 'plain' }
  await host.ctx.plugin({ name: 'plain-provider', apply: inner => inner.provide('plain', plain) })
  assert.equal(host.ctx.get('plain'), host.ctx.get('plain'))
  assert.equal(host.ctx.get('plain'), plain)
})

test('every injected service and every optional service the host reads has the members its call sites use', async () => {
  // services.test.js:27-39 的 SERVICE_MEMBERS 表：这里逐成员断言 fake 的默认值在位且可调用。
  const host = fakeHost()
  const members = {
    llm: ['stream', 'resolveModelInfo', 'listConfigurableProviders', 'registerAdapter', 'listProviders', 'listModels', 'discoverModels'],
    tools: ['register', 'schemas', 'restrict', 'guard'],
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
  for (const [name, list] of Object.entries(members)) {
    const service = host.ctx.get(name)
    assert.notEqual(service, undefined, `${name} is not provided on the fake host`)
    for (const member of list) assert.equal(typeof service[member], 'function', `${name}.${member} is not callable`)
  }
  assert.equal(typeof host.ctx.get('sessions').messageProjections, 'object')
  assert.equal(typeof host.ctx.get('connection').fetch, 'object')
  assert.deepEqual(await host.ctx.get('schedule').catalog(), [])
})

// ============================================================================
// 4. 工具面（dev/contract/tools-and-hidden.test.js）
// ============================================================================

test('a registered tool is visible in the model-facing schemas and runs through the execution pipeline', async () => {
  const host = fakeHost()
  let seen
  host.ctx.tools.register(tool('list_bots', (args, exec) => { seen = { args, name: exec.name }; return 'No Bots yet.' }))
  assert.deepEqual(host.ctx.tools.schemas(), [{
    name: 'list_bots',
    description: 'list_bots tool',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to say.' } } },
  }])
  assert.equal('execute' in host.ctx.tools.schemas()[0], false)
  assert.equal(host.ctx.tools.get('list_bots')?.name, 'list_bots')
  const first = host.ctx.tools.schemas()[0]
  first.parameters.properties.text.type = 'number'
  assert.equal(host.ctx.tools.schemas()[0].parameters.properties.text.type, 'string')

  const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'list_bots', arguments: { room: 'general' } })
  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(result.value, 'No Bots yet.')
  assert.deepEqual(result.content, [{ type: 'text', text: 'No Bots yet.' }])
  assert.equal(Object.isFrozen(result), true, 'the outcome is a frozen snapshot')
  assert.equal(seen.name, 'list_bots')
  assert.deepEqual(seen.args, { room: 'general' })
})

test('register returns the disposer that takes the tool out of both surfaces', async () => {
  const host = fakeHost()
  const dispose = host.ctx.tools.register(tool('probe', () => 'ran'))
  dispose()
  assert.deepEqual(host.ctx.tools.schemas(), [])
  assert.equal(host.ctx.tools.get('probe'), undefined)
  const missing = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'probe', arguments: {} })
  assert.equal(missing.isError, true)
  assert.equal(missing.error.message, 'unknown tool "probe"')
  assert.deepEqual(missing.error.info, { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
  assert.deepEqual(missing.content, [{ type: 'text', text: 'Error: unknown tool "probe"' }])
})

test('a tool registered through a plugin context belongs to that plugin\'s fiber', async () => {
  const host = fakeHost()
  const plugin = inner => { inner.tools.register(tool('plugin_tool', () => 'ran')) }
  plugin.inject = ['tools']
  const fiber = await host.ctx.plugin(plugin)
  assert.deepEqual(host.ctx.tools.schemas().map(schema => schema.name), ['plugin_tool'])
  await fiber.dispose()
  assert.deepEqual(host.ctx.tools.schemas(), [])
})

test('the registry refuses a duplicate name, the reserved run_code transport, and a definition without an output contract', () => {
  const host = fakeHost()
  const first = tool('probe', () => 'ran')
  host.ctx.tools.register(first)
  assert.throws(() => host.ctx.tools.register(first), /tool "probe" is already registered \(for a per-agent variant/u)
  assert.throws(() => host.ctx.tools.register(tool('run_code', () => 'ran')), /tool name "run_code" is reserved for the PTC mode presentation transport/u)
  assert.throws(() => host.ctx.tools.register({ name: 'no_output', description: 'd', parameters: {}, execute: async () => 'x' }), {
    name: 'TypeError',
    message: 'tool "no_output" must declare output { schema, render, presentationMeta? }',
  })
})

test('schemas(agent) reports the global view for an agent nothing has been restricted for yet', async () => {
  const host = fakeHost()
  host.ctx.tools.register(tool('probe', () => 'ran'))
  const a = fakeAgent(host, { id: 'chat-a' })
  const b = fakeAgent(host, { id: 'chat-b' })
  assert.deepEqual(host.ctx.tools.schemas(a).map(schema => schema.name), ['probe'])
  assert.deepEqual(host.ctx.tools.schemas(b).map(schema => schema.name), ['probe'])
  assert.equal(host.ctx.tools.schemas(a).some(schema => schema.name === 'create_goal'), false)
})

test('a scoped restriction hides inherited global tools from one agent, in the schemas and at execution', async () => {
  const host = fakeHost()
  let runs = 0
  host.ctx.tools.register(tool('probe', () => { runs += 1; return 'ran' }))
  const a = fakeAgent(host, { id: 'chat-a' })
  const b = fakeAgent(host, { id: 'chat-b' })

  const lift = a.ctx.tools.restrict({ deny: ['probe'] })
  assert.deepEqual(host.ctx.tools.schemas(a).map(schema => schema.name), [])
  assert.deepEqual(host.ctx.tools.schemas(b).map(schema => schema.name), ['probe'])
  assert.deepEqual(host.ctx.tools.schemas().map(schema => schema.name), ['probe'])
  assert.equal(host.ctx.tools.get('probe', a), undefined)

  const denied = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'probe', arguments: {}, agent: a })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, 'unknown tool "probe"')
  assert.equal(runs, 0)
  assert.equal((await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c2', name: 'probe', arguments: {}, agent: b })).isError, false)
  assert.equal(runs, 1)

  lift()
  assert.deepEqual(host.ctx.tools.schemas(a).map(schema => schema.name), ['probe'])
  assert.equal((await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c3', name: 'probe', arguments: {}, agent: a })).isError, false)
  assert.equal(runs, 2)
})

test('restrict composes: allow keeps only the listed globals, deny intersects it, and a scope\'s own registration is exempt', async () => {
  const host = fakeHost()
  for (const name of ['t1', 't2', 't3']) host.ctx.tools.register(tool(name, () => name))
  const a = fakeAgent(host, { id: 'chat-a' })

  a.ctx.tools.restrict({ allow: ['t1', 't2'] })
  assert.deepEqual(host.ctx.tools.schemas(a).map(schema => schema.name), ['t1', 't2'])
  a.ctx.tools.restrict({ deny: ['t2'] })
  assert.deepEqual(host.ctx.tools.schemas(a).map(schema => schema.name), ['t1'])

  a.ctx.tools.register(tool('own', () => 'own'))
  assert.deepEqual(host.ctx.tools.schemas(a).map(schema => schema.name), ['t1', 'own'])
  assert.throws(() => a.ctx.tools.restrict({ deny: ['own'] }), /names unknown global tool "own"; known global tools: /u)
})

test('restrict refuses an empty filter, an unknown global name, and a context-global call', async () => {
  const host = fakeHost()
  host.ctx.tools.register(tool('probe', () => 'ran'))
  const a = fakeAgent(host, { id: 'chat-a' })
  assert.throws(() => a.ctx.tools.restrict({}), /tools\.restrict\(\{\}\) is a no-op/u)
  assert.throws(() => a.ctx.tools.restrict({ deny: ['ask_user_question'] }), /names unknown global tool "ask_user_question"/u)
  assert.throws(() => host.ctx.tools.restrict({ deny: ['probe'] }), /requires a scoped context \(agent\.ctx\)/u)
})

test('a guard denies before the tool body runs, and its disposer lifts the denial', async () => {
  const host = fakeHost()
  let runs = 0
  host.ctx.tools.register(tool('ask_user_question', () => { runs += 1; return 'asked' }))
  const botChat = fakeAgent(host, { id: 'bot-chat' })
  const userChat = fakeAgent(host, { id: 'user-chat' })
  const isBotSession = id => id === 'bot-chat'
  const reason = 'Bots cannot use ask_user_question. Ask with ask_user in your own chat, or ask in your reply.'
  const seen = []

  const lift = host.ctx.tools.guard(exec => {
    seen.push({ name: exec.name, agentIsBotChat: exec.agent === botChat, frozen: Object.isFrozen(exec.arguments) })
    return exec.name === 'ask_user_question' && isBotSession(exec.agent?.id) ? reason : undefined
  })
  const denied = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'ask_user_question', arguments: {}, agent: botChat })
  assert.equal(denied.isError, true)
  assert.equal(denied.error.message, reason)
  assert.deepEqual(denied.content, [{ type: 'text', text: `Error: ${reason}` }])
  assert.equal(runs, 0, 'the body never runs')
  assert.equal((await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c2', name: 'ask_user_question', arguments: {}, agent: userChat })).isError, false)
  assert.equal(runs, 1)
  assert.deepEqual(seen, [
    { name: 'ask_user_question', agentIsBotChat: true, frozen: true },
    { name: 'ask_user_question', agentIsBotChat: false, frozen: true },
  ])

  lift()
  assert.equal((await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c3', name: 'ask_user_question', arguments: {}, agent: botChat })).isError, false)
  assert.equal(runs, 2)
})

test('guards run in registration order, the first denial wins, and no guard can force-allow', async () => {
  // :278-290 只证明了顺序与首个拒绝生效；「任何 guard 都不能强制放行」是从 string|undefined
  // 返回类型推出的推断（host.js §6）——fake 同样只实现「undefined 放行、string 拒绝」。
  const host = fakeHost()
  host.ctx.tools.register(tool('probe', () => 'ran'))
  const asked = []
  const first = host.ctx.tools.guard(() => { asked.push('first'); return undefined })
  const second = host.ctx.tools.guard(() => { asked.push('second'); return 'second denies' })
  const third = host.ctx.tools.guard(() => { asked.push('third'); return 'third never reached' })
  const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'probe', arguments: {} })
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'second denies')
  assert.deepEqual(asked, ['first', 'second'])
  first(); second(); third()
})

test('a tools/execute middleware rewrite reaches the tool body, and a veto keeps the body from running', async () => {
  const host = fakeHost()
  let seenArgs
  host.ctx.tools.register(tool('echo', args => { seenArgs = args; return `echo:${args.text}` }))
  const order = []
  await host.ctx.plugin(inner => {
    inner.on('tools/execute', async (exec, next) => { order.push('rewrite'); exec.arguments = { text: 'rewritten' }; return next() })
  })
  assert.equal((await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'echo', arguments: { text: 'hi' } })).value, 'echo:rewritten')
  assert.deepEqual(order, ['rewrite'])
  assert.deepEqual(seenArgs, { text: 'rewritten' })

  await host.ctx.plugin(inner => {
    inner.on('tools/execute', async () => { order.push('veto'); return { isError: false, value: 'blocked' } }, { prepend: true })
  })
  const vetoed = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c2', name: 'echo', arguments: { text: 'hi' } })
  assert.equal(vetoed.isError, false, vetoed.error?.message)
  assert.equal(vetoed.value, 'blocked')
  assert.deepEqual(order, ['rewrite', 'veto'])
})

test('a throwing tools/execute middleware becomes a structured tool error rather than a rejected execute()', async () => {
  const host = fakeHost()
  host.ctx.tools.register(tool('echo', () => 'echo:hi'))
  const order = []
  await host.ctx.plugin(inner => {
    inner.on('tools/execute', async (exec, next) => { order.push('outer-in'); const result = await next(); order.push('outer-out'); return result })
    inner.on('tools/execute', async () => { order.push('thrower'); throw new Error('middleware-boom') })
  })
  const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'echo', arguments: { text: 'hi' } })
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'middleware-boom')
  assert.deepEqual(order, ['outer-in', 'thrower'])
})

test('an unknown tool still runs the tools/execute chain and hands its structured error back through it', async () => {
  const host = fakeHost()
  host.ctx.tools.register(tool('echo', () => 'echo:hi'))
  const order = []
  await host.ctx.plugin(inner => {
    inner.on('tools/execute', async (exec, next) => { order.push('in'); const result = await next(); order.push(`out:${result.isError}`); return result })
  })
  const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name: 'nope', arguments: {} })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /unknown tool "nope"/u)
  assert.deepEqual(order, ['in', 'out:true'])
})

// ============================================================================
// 5. 连接面（dev/contract/tools-and-hidden.test.js:356-468）
// ============================================================================

test('the two host routes are exact Fetch routes on the shared /api channel and answer through it', async () => {
  const host = fakeHost()
  const seen = []
  host.ctx.effect(() => host.ctx.connection.fetch.register({
    path: '/api/bot',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      seen.push({ path: new URL(request.url).pathname, method: request.method, body: await request.text() })
      return Response.json({ ok: true })
    },
  }), 'ds-bot: api route')
  host.ctx.effect(() => host.ctx.connection.fetch.register({
    path: '/api/bot/feed',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response('event: hello\ndata: {"revision":1}\n\n', { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
  }), 'ds-bot: live feed route')

  const handler = host.ctx.connection.createSharedFetchHandler('/api')
  const api = await handler.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: '{"endpoint":"ping"}' }), host.ctx.connection.browserPeer)
  assert.equal(api.status, 200)
  assert.deepEqual(await api.json(), { ok: true })
  assert.deepEqual(seen, [{ path: '/api/bot', method: 'POST', body: '{"endpoint":"ping"}' }])

  const feed = await handler.fetch(new Request('http://localhost/api/bot/feed'), host.ctx.connection.browserPeer)
  assert.equal(feed.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(await feed.text(), 'event: hello\ndata: {"revision":1}\n\n')

  assert.equal(handler.requestBodyMode({ method: 'POST', url: new URL('http://localhost/api/bot') }), 'buffered')
  assert.equal(handler.requestBodyMode({ method: 'GET', url: new URL('http://localhost/api/bot') }), 'buffered')
  assert.equal(handler.requestBodyMode({ method: 'GET', url: new URL('http://localhost/api/session') }), 'buffered')
})

test('an exact Fetch route is served before the shared RPC channel, and what it does not cover falls through', async () => {
  const host = fakeHost()
  const served = []
  const routeDisposer = host.ctx.effect(() => host.ctx.connection.fetch.register({
    path: '/api/bot',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => { served.push('exact'); return Response.json({ served: 'exact' }) },
  }), 'ds-bot: api route')
  host.ctx.effect(() => host.ctx.connection.rpc.intercept('/api', endpoint => endpoint === 'bot',
    async (endpoint, payload, signal, peer) => {
      served.push(`interceptor:${endpoint}:${peer.principal.kind}`)
      return { ok: true, value: { served: 'interceptor', endpoint } }
    }), 'probe interceptor')

  const handler = host.ctx.connection.createSharedFetchHandler('/api')
  const envelope = { type: 'client-request', rpcId: 'r1', method: 'bot', payload: { endpoint: 'ping' } }
  const exact = await handler.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify(envelope) }), host.ctx.connection.browserPeer)
  assert.deepEqual(await exact.json(), { served: 'exact' })

  const wrongMethod = await handler.fetch(new Request('http://localhost/api/bot'), host.ctx.connection.browserPeer)
  assert.equal(wrongMethod.status, 404)
  assert.equal(await wrongMethod.text(), 'not found')

  await routeDisposer()
  const through = await handler.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify(envelope) }), host.ctx.connection.browserPeer)
  assert.deepEqual(await through.json(), {
    type: 'server-response',
    rpcId: 'r1',
    result: { ok: true, value: { served: 'interceptor', endpoint: 'bot' } },
  })
  assert.deepEqual(served, ['exact', 'interceptor:bot:owner'])
})

test('the route registry validates its shape, refuses a duplicate path, and refuses a peer that is not the owner', async () => {
  const host = fakeHost()
  const register = route => host.ctx.connection.fetch.register(route)
  const route = { path: '/api/bot', methods: ['POST'], requestBody: 'buffered', fetch: async () => new Response('x') }
  assert.throws(() => register({ ...route, path: '/bot' }), { message: 'connection: invalid exact Fetch route "/bot"' })
  assert.throws(() => register({ ...route, path: '/api/bot/../x' }), { message: 'connection: invalid exact Fetch route "/api/bot/../x"' })
  assert.throws(() => register({ ...route, methods: [] }), { message: 'connection: exact Fetch route "/api/bot" declares no methods' })
  assert.throws(() => register({ ...route, methods: ['POST', 'POST'] }), { message: 'connection: exact Fetch route "/api/bot" repeats a method' })

  host.ctx.effect(() => host.ctx.connection.fetch.register(route), 'ds-bot: api route')
  assert.throws(() => host.ctx.effect(() => host.ctx.connection.fetch.register(route)), {
    message: 'connection: exact Fetch route "/api/bot" is already registered',
  })

  const handler = host.ctx.connection.createSharedFetchHandler('/api')
  const unknown = await handler.fetch(new Request('http://localhost/api/nope'), host.ctx.connection.browserPeer)
  assert.equal(unknown.status, 404)
  assert.equal(await unknown.text(), 'not found')
  const stranger = host.ctx.connection.createPeer({ principal: { kind: 'peer' } })
  const forbidden = await handler.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: '{}' }), stranger)
  assert.equal(forbidden.status, 403)
  assert.equal(await forbidden.text(), 'forbidden')
})

// ============================================================================
// 6. 对象面：agent / inbox / session（dev/contract/session-objects.test.js）
// ============================================================================

test('a fresh agent has an empty durable inbox that reads as two named lists', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'inbox-empty' })
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.deepEqual(agent.inbox.nextTurn, [])
  assert.deepEqual(agent.inbox['nextStep'], [])
  assert.deepEqual(agent.inbox['nextTurn'], [])
  assert.equal(agent.inbox.hasPending, false)
  assert.equal(agent.session.seq, 0)
})

test('inbox.prepend puts a message at the front of its own list and append at the end, as durable splices', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'inbox-prepend' })
  const texts = list => list.map(message => message.content[0].text)
  agent.inbox.prepend('next-step', prompt('first'))
  agent.inbox.prepend('next-step', prompt('second'))
  agent.inbox.append('next-step', prompt('third'))
  agent.inbox.prepend('next-turn', prompt('turn-a'))
  agent.inbox.append('next-turn', prompt('turn-b'))

  assert.deepEqual(texts(agent.inbox.nextStep), ['second', 'first', 'third'])
  assert.deepEqual(texts(agent.inbox.nextTurn), ['turn-a', 'turn-b'])

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

test('inbox.remove drops one pending message by id and reports whether it was pending, and the projection agrees', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'inbox-remove' })
  agent.inbox.prepend('next-step', prompt('keep'))
  agent.inbox.prepend('next-step', prompt('drop'))
  const kept = agent.inbox.nextStep.find(message => message.content[0].text === 'keep')

  assert.equal(agent.inbox.remove(kept.id), true)
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['drop'])
  assert.equal(agent.inbox.remove('no-such-message'), false)

  const state = host.ctx.get('sessionProjections').stateOf(agent.session, 'inbox')
  assert.deepEqual(state['next-step'].map(message => message.content[0].text), ['drop'])
})

test('inbox.clear empties both lists, cancelling next-step before next-turn', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'inbox-clear' })
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

test('inbox.prepend is durable state and does not wake the driver', async () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'inbox-no-wake' })
  agent.inbox.prepend('next-step', prompt('parked'))
  assert.equal(agent.status, 'idle')
  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])
})

test('agent.send parks input without a wake, and one wake drains the whole pending queue', async () => {
  const host = fakeHost()
  const parked = fakeAgent(host, { id: 'inbox-send-park' })
  parked.send(prompt('parked'), 'next-step', false)
  assert.equal(parked.status, 'idle')
  await parked.whenIdle()
  assert.equal(parked.status, 'idle')
  assert.deepEqual(parked.inbox.nextStep.map(message => message.content[0].text), ['parked'])

  const claimed = []
  const agent = fakeAgent(host, {
    id: 'inbox-send',
    driver: async ({ messages, turn }) => { for (const message of messages) claimed.push([message.content[0].text, turn]) },
  })
  agent.inbox.prepend('next-step', prompt('step-1'))
  agent.inbox.append('next-step', prompt('step-2'))
  agent.inbox.prepend('next-turn', prompt('turn-1'))
  agent.inbox.append('next-turn', prompt('turn-2'))
  agent.send(prompt('wake'), 'next-turn', true)
  await agent.whenIdle()

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

test('agent.followup queues a next-turn message, wakes the driver, and claims it before returning', async () => {
  const host = fakeHost()
  const inserted = []
  const agent = fakeAgent(host, { id: 'followup-claim' })
  agent.ctx.on('agent/inbox/inserted', ({ message }) => inserted.push(message.content[0].text))
  agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => inserted.push([`claimed:${message.content[0].text}`, turn]))

  agent.followup(prompt('solo'))
  assert.equal(agent.status, 'running')
  assert.deepEqual(agent.inbox.nextTurn, [])
  assert.deepEqual(inserted, ['solo', ['claimed:solo', 1]])

  await agent.whenIdle()
  assert.equal(agent.status, 'idle')
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data), [{ turn: 1 }])
  assert.deepEqual(agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content[0].text), ['solo'])
})

test('agent.followup gives every message its own turn and keeps the durable user message', async () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'followup-turns' })
  agent.followup(prompt('one'))
  agent.followup(prompt('two'))
  await agent.whenIdle()

  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data), [{ turn: 1 }, { turn: 2 }])
  assert.deepEqual(agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content[0].text), ['one', 'two'])
  assert.deepEqual(agent.inbox.nextTurn, [])
  const logged = agent.session.snapshotEvents().find(event => event.type === 'user/message').data
  assert.equal(logged.source.kind, 'user')
  assert.equal(typeof logged.id, 'string')
})

test('agent.cancel discards pending inbox work unless keepInbox preserves it', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'followup-cancel' })
  agent.inbox.prepend('next-step', prompt('parked'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  assert.deepEqual(agent.inbox.nextStep.map(message => message.content[0].text), ['parked'])

  agent.cancel({ kind: 'user' })
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.deepEqual(agent.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .map(event => event.data.outcome), [undefined, 'canceled'])
})

test('agent.ctx tears its contributions down with the agent and then refuses new ones', async () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'ctx-teardown' })
  let torn = 0
  agent.ctx.effect(() => () => { torn += 1 }, 'ds-bot: contract teardown')
  await agent.ctx.plugin({ name: 'contract-child', apply() {} })
  assert.equal(torn, 0)

  await agent.dispose()
  assert.equal(torn, 1)
  assert.throws(() => agent.ctx.effect(() => () => {}), /inactive context/u)
  assert.throws(() => agent.ctx.plugin({ name: 'contract-late', apply() {} }), /inactive context/u)
})

test('agent.ctx listeners are scope-filtered to their own agent', async () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'ctx-scope' })
  const other = fakeAgent(host, { id: 'ctx-scope-other' })
  const own = []
  const foreign = []
  agent.ctx.on('agent/status', ({ status }) => own.push(status))
  other.ctx.on('agent/status', ({ status }) => foreign.push(status))

  other.followup(prompt('theirs'))
  await other.whenIdle()
  assert.deepEqual(own, [])
  assert.deepEqual(foreign, ['running', 'idle'])
})

test('session.append returns the committed event and grows seq by exactly one', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'append-commit' })
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

test('session.append enforces the surface-op contract on both sides', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'append-surface' })
  const session = agent.session
  const user = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, id: 'u-1' }

  assert.throws(() => session.append('user/message', user), /surfaceOp/u)
  assert.throws(() => session.append('turn/start', { turn: 1 }, { surfaceOp: 'append' }), /not surface-eligible/u)
  assert.throws(() => session.append('user/message', user, { surfaceOp: 'append', sourceEventSeqs: [] }), /sourceEventSeqs must not be empty/u)
  assert.equal(session.append('user/message', user, { surfaceOp: 'append' }).seq, 0)
  assert.equal(session.seq, 1)
})

test('session.append accepts image/offload only where its projection is registered', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'offload-missing' })
  const session = agent.session
  const logBefore = session.seq
  // images.js:199 checks exactly this before appending.
  assert.equal(host.ctx.get('sessions').messageProjections.some(projection => projection.type === 'image/offload'), false)
  assert.throws(() => session.append('image/offload', { targets: [{ seq: 0, imageIndexes: [0] }] }), /requires a message projection/u)
  assert.equal(session.seq, logBefore)

  host.ctx.get('sessionProjections').register({ type: 'image/offload', fold: () => ({}) })
  assert.equal(host.ctx.get('sessions').messageProjections.some(projection => projection.type === 'image/offload'), true)
  const offload = session.append('image/offload', { targets: [{ seq: 0, imageIndexes: [0] }] })
  assert.equal(offload.type, 'image/offload')
  assert.equal(offload.seq, session.seq - 1)
})

test('session.header is a frozen record that mirrors the session identity and creation cwd', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'header-record', session: fakeSession(host, { id: 'header-record', cwd: 'C:\\contract' }) })
  const session = agent.session
  assert.equal(session.header.version, 4)
  assert.equal(session.header.id, session.id)
  assert.equal(agent.id, session.id)
  assert.equal(session.header.cwd, 'C:\\contract')
  assert.equal(session.header.isSeeded, false)
  assert.equal(typeof session.header.createdAt, 'number')
  assert.equal(Object.isFrozen(session.header), true)
  assert.throws(() => { session.header.cwd = 'C:\\elsewhere' }, /read only/u)
})

test('session.requestHeader is undefined until a header event and then folds to the newest one', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'request-header' })
  const session = agent.session
  assert.equal(session.requestHeader(), undefined)

  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake-1' } },
    reason: 'start',
  })
  const logged = session.requestHeader()
  assert.deepEqual(logged.config, { provider: 'fake', model: 'fake-1' })
  assert.equal(logged.tools, undefined)
  assert.equal(session.requestHeader(), logged)

  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake-1', maxTokens: 32 }, tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] },
    reason: 'change',
  })
  const folded = session.requestHeader()
  assert.deepEqual(folded.config, { provider: 'fake', model: 'fake-1', maxTokens: 32 })
  assert.deepEqual(folded.tools.map(entry => entry.name), ['t'])
  assert.equal(session.requestHeader(), folded)
})

test('session.deriveMessages returns fresh arrays of shared frozen messages, and follows a surface replacement', () => {
  const host = fakeHost()
  const agent = fakeAgent(host, { id: 'derive-replace' })
  const session = agent.session
  assert.deepEqual(session.deriveMessages(), [])

  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' }, id: 'r-1' }, { surfaceOp: 'append' })
  assert.deepEqual(session.deriveMessages().map(message => message.content[0].text), ['first'])

  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' }, id: 'r-2' }, {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [0],
  })
  // parts.js:428/501/910 和 btw.js:144 读派生历史：压缩 replace 要能透出来，而日志两条都在。
  assert.deepEqual(session.deriveMessages().map(message => message.content[0].text), ['second'])
  assert.equal(session.seq, 2)
  assert.deepEqual(session.snapshotEvents().map(event => event.data?.id), ['r-1', 'r-2'])

  // 之后的 append 不长大调用方已持有的数组，元素是共享的冻结消息（:418-439）。
  const before = session.deriveMessages()
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'third' }], source: { kind: 'user' }, id: 'r-3' }, { surfaceOp: 'append' })
  const after = session.deriveMessages()
  assert.equal(before.length, 1)
  assert.deepEqual(after.map(message => message.content[0].text), ['second', 'third'])
  assert.equal(before[0], after[0])
  assert.equal(Object.isFrozen(after[0]), true)
  assert.equal(Object.isFrozen(after[0].content), true)
  assert.equal(Object.isFrozen(after[0].content[0]), true)
})

test('session/event is a synchronous notice in registration order with prepend, and contains a throwing listener', async () => {
  const warnings = []
  const host = noisyHost(warnings)
  const order = []
  await host.ctx.plugin(inner => {
    inner.on('session/event', (session, event) => order.push(`A:${event.type}#${event.seq}`))
    inner.on('session/event', (session, event) => order.push(`B:${event.type}#${event.seq}`))
    inner.on('session/event', (session, event) => order.push(`P:${event.type}#${event.seq}`), { prepend: true })
  })
  const session = host.ctx.get('sessions').create('contract-session')
  order.length = 0
  const event = session.append('plugin:contract/ping', { note: 'hi' })
  assert.deepEqual(order, ['P:plugin:contract/ping#0', 'A:plugin:contract/ping#0', 'B:plugin:contract/ping#0'])
  assert.equal(Object.isFrozen(event), true)
  assert.equal(Object.isFrozen(event.data), true)
  assert.equal(session.seq, 1)

  const noisy = noisyHost(warnings)
  await noisy.ctx.plugin(inner => {
    inner.on('session/event', () => { throw new Error('sync-boom') })
    inner.on('session/event', async () => { await sleep(1); throw new Error('async-boom') })
  })
  const guarded = noisy.ctx.get('sessions').create('guarded-session')
  warnings.length = 0
  guarded.append('plugin:contract/ping', { note: 'hi' })
  await sleep(10)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /session "guarded-session": session\/event listener threw: Error: sync-boom/u)
  assert.match(warnings[1], /session "guarded-session": session\/event listener rejected: Error: async-boom/u)
})

// ============================================================================
// 7. 隐藏运行时态（dev/contract/tools-and-hidden.test.js:292-354）
// ============================================================================

test('ctx.fiber is the plugin\'s fiber: uid 0 at the root, a number while live, null once unloaded', async () => {
  const host = fakeHost()
  let inner, uidInDisposer
  const plugin = scope => {
    inner = scope
    scope.effect(() => () => { uidInDisposer = scope.fiber.uid }, 'probe')
  }
  plugin.inject = ['tools']
  const fiber = await host.ctx.plugin(plugin)

  assert.equal(host.ctx.fiber.uid, 0, 'the root fiber')
  assert.equal(typeof fiber.uid, 'number')
  assert.ok(fiber.uid > 0, 'a plugin fiber is allocated a positive uid')
  assert.equal(typeof inner.tools.execute, 'function')

  await fiber.dispose()
  assert.equal(inner.fiber.uid, null)
  assert.equal(uidInDisposer, null)
})

test('an unloaded context answers a service lookup and a new effect with the inactive-context error', async () => {
  const host = fakeHost()
  let inner, serviceInDisposer
  const plugin = scope => {
    inner = scope
    scope.effect(() => () => { serviceInDisposer = typeof scope.tools.execute }, 'probe')
  }
  plugin.inject = ['tools']
  const fiber = await host.ctx.plugin(plugin)
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
  assert.deepEqual(messages, [
    'cannot get required service "tools" in inactive context',
    'cannot create effect on inactive context',
    'cannot create effect on inactive context',
  ])
  assert.match(messages[0], /in inactive context/)
  assert.doesNotMatch(messages[1], /in inactive context/)
  assert.equal(serviceInDisposer, 'function')
  inner.logger.warn('after unload')
})

test('the unloaded predicate reads both halves: uid === null and the inactive-context message', async () => {
  const host = fakeHost()
  let inner
  const plugin = scope => { inner = scope }
  plugin.inject = ['tools']
  const fiber = await host.ctx.plugin(plugin)
  await fiber.dispose()

  assert.equal(isUnloaded(inner, undefined), true)
  let error
  try { void inner.tools } catch (caught) { error = caught }
  assert.equal(isUnloaded(inner, error), true)
  assert.equal(isUnloaded({ fiber: { uid: 1 } }, error), true, 'the message half alone is enough while the uid is still live')
  assert.equal(isUnloaded({ fiber: { uid: 1 } }, new Error('other')), false)
})

// ============================================================================
// 8. 装配面与契约索引对账
// ============================================================================

test('fakeRuntime builds the rt index.js hands to the modules, and a create hook can replace it', async () => {
  const { ctx, rt, dispose } = fakeRuntime({ home: '/tmp/fake-host-home', config: { mainName: 'Chief' } })
  assert.deepEqual(Object.keys(rt).sort(), ['config', 'ctx', 'defaults', 'dshHome', 'home', 'statePath'])
  assert.equal(rt.ctx, ctx)
  assert.equal(rt.home, '/tmp/fake-host-home')
  assert.equal(rt.statePath, '/tmp/fake-host-home/state.json')
  assert.deepEqual(rt.defaults, { mainName: 'Chief', mainRole: 'Chief of Staff' })
  // ctx 正是 index.js apply(ctx) 拿到的那个作用域：八个 inject 服务属性读可用。
  for (const name of HOST_CONTRACT.injectedServices) assert.notEqual(ctx[name], undefined, name)
  // 可选服务照契约走 ctx.get，属性读抛 without inject。
  assert.equal(typeof ctx.get('goals'), 'object')
  assert.throws(() => void ctx.goals, /cannot get property "goals" without inject/u)
  await dispose()

  const seen = []
  const custom = fakeRuntime({
    home: '/tmp/fake-host-home',
    config: { mainRole: 'Lead' },
    create: (scope, config) => { seen.push([scope, config]); return { ctx: scope, config, custom: true } },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], custom.ctx)
  assert.deepEqual(seen[0][1], { mainRole: 'Lead' })
  assert.equal(custom.rt.custom, true)
  await custom.dispose()
})

test('every name in HOST_CONTRACT is in place on the fake', async () => {
  const host = fakeHost()
  for (const name of HOST_CONTRACT.injectedServices) assert.equal(typeof host.ctx.get(name), 'object', name)
  for (const name of HOST_CONTRACT.optionalServices) assert.notEqual(host.ctx.get(name), undefined, name)
  for (const name of HOST_CONTRACT.dynamicInject) {
    const attached = []
    const state = host.ctx.inject([name], sub => attached.push(sub))
    await state.await()
    assert.equal(attached.length, 1, name)
    assert.notEqual(attached[0][name], undefined, name)
  }
  for (const name of [...HOST_CONTRACT.events.core, ...HOST_CONTRACT.events.optional]) {
    const dispose = host.ctx.on(name, () => {})
    assert.equal(typeof dispose, 'function', name)
    dispose()
  }
  for (const name of HOST_CONTRACT.tools) assert.equal(typeof host.ctx.tools[name], 'function', name)
  assert.equal(typeof host.ctx.connection.fetch.register, 'function')
  assert.equal(typeof host.ctx.effect, 'function')
  assert.equal(host.ctx.fiber.uid, 0)
  assert.equal(typeof isUnloaded(host.ctx, undefined), 'boolean')

  const agent = fakeAgent(host, { id: 'contract-walk' })
  for (const name of HOST_CONTRACT.agent) assert.notEqual(agent[name], undefined, name)
  for (const name of HOST_CONTRACT.inbox) assert.notEqual(agent.inbox[name], undefined, name)
  for (const name of HOST_CONTRACT.session) assert.notEqual(agent.session[name], undefined, name)
  for (const [service, members] of Object.entries(HOST_CONTRACT.optionalServiceMembers)) {
    const face = host.ctx.get(service)
    for (const member of members) assert.notEqual(face[member], undefined, `${service}.${member}`)
  }
})

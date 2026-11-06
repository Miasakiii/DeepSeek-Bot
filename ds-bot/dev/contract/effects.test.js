// Behavior locks for the effect/dispose lifecycle of the real DeepSeek Harness runtime
// (C0.2 face 4). Every assertion here was measured against @deepseek-ai/cordis as
// `npm run harness` installs it; nothing is taken from documentation. The disposers that
// would break the team if they never ran (C0 baseline §2.2) are covered one pattern at a
// time at the bottom.
//
// Run: node --import ./test/harness-resolve.mjs --test dev/contract/effects.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { fakeContext } from '../../test/fake-ctx.js'

// A plugin loaded into a fresh root context. The body registers its effects on the
// plugin's own context, which is the scope every src/host module installs into, and
// disposing the fiber runs the unload path those effects are cleaned up on.
const load = async body => {
  const ctx = new Context()
  let scope
  const fiber = await ctx.plugin(inner => { scope = inner; body(inner) })
  return { ctx, fiber, scope }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('ctx.effect runs its body at registration and returns a callable, thenable disposer', async t => {
  const marks = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())

  const first = ctx.effect(() => { marks.push('first'); return () => marks.push('first dispose') }, 'first')
  const second = ctx.effect(() => { marks.push('second'); return null }, 'second')
  const third = ctx.effect(() => { marks.push('third'); return undefined }, 'third')

  assert.deepEqual(marks, ['first', 'second', 'third'])
  for (const disposer of [first, second, third]) {
    assert.equal(typeof disposer, 'function')
    assert.equal(typeof disposer.then, 'function')
  }
  assert.equal(first[Context.effect].label, 'first')
  assert.deepEqual(ctx.fiber.getEffects().map(meta => meta.label), ['first', 'second', 'third'])
  // A body that returns nothing is an effect with nothing to clean up, not an error.
  await ctx.fiber.dispose()
  assert.deepEqual(marks, ['first', 'second', 'third', 'first dispose'])
})

test('an effect body may return nothing, and may not return a value that is not a disposer', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const plain = ctx.effect(() => undefined)
  assert.equal(typeof plain, 'function')
  assert.equal(plain[Context.effect].label, 'anonymous')
  assert.throws(() => ctx.effect(() => 'not a disposer', 'bad'), { name: 'TypeError', message: 'Invalid effect' })
})

test('a disposer that returns a promise holds the unload open until it settles', async () => {
  const marks = []
  const { fiber } = await load(scope => {
    scope.effect(() => () => { marks.push('sync') }, 'sync')
    scope.effect(() => async () => {
      marks.push('async start')
      await sleep(10)
      marks.push('async end')
    }, 'async')
  })
  const task = fiber.dispose()
  assert.equal(typeof task.then, 'function', 'the unload settles as a promise')
  await task
  // Reverse registration order to start; the sync disposer has already finished while the
  // async one is still waiting, and the unload waits for the slower of the two.
  assert.deepEqual(marks, ['async start', 'sync', 'async end'])
})

test('an effect whose body returns a promise keeps the disposer that promise resolves to', async () => {
  const marks = []
  const { fiber } = await load(scope => {
    scope.effect(() => Promise.resolve().then(() => {
      marks.push('promise body')
      return () => marks.push('promise disposer')
    }), 'promise')
    scope.effect(async () => {
      await Promise.resolve()
      marks.push('async body')
      return () => marks.push('async disposer')
    }, 'async body')
  })
  // Neither body waits for the load to settle, but neither does the unload need to: the
  // disposers they hand back are collected whenever the promises resolve.
  await fiber.dispose()
  // Bodies in registration order, disposers in reverse.
  assert.deepEqual(marks, ['promise body', 'async body', 'async disposer', 'promise disposer'])
})

test('the fake context drops a disposer that arrives through a promise, the real one keeps it', async () => {
  // The gap at test/fake-ctx.js:60-68: `const dispose = execute()` only keeps a disposer
  // the body handed back directly, so a promise-returning body loses its cleanup.
  const marks = []
  const fake = fakeContext()
  fake.effect(() => () => marks.push('sync'), 'sync')
  fake.effect(() => Promise.resolve(() => marks.push('promise')), 'promise')
  fake.effect(async () => () => marks.push('async body'), 'async body')
  await fake.dispose()
  assert.deepEqual(marks, ['sync'])
})

test('effects are disposed in reverse registration order, all of them started before any finishes', async () => {
  const marks = []
  const { fiber } = await load(scope => {
    scope.effect(() => async () => {
      marks.push('slow start')
      await sleep(15)
      marks.push('slow end')
    }, 'slow')
    scope.effect(() => () => marks.push('sync'), 'sync')
    scope.effect(() => async () => {
      marks.push('quick start')
      await sleep(1)
      marks.push('quick end')
    }, 'quick')
  })
  await fiber.dispose()
  assert.deepEqual(marks, ['quick start', 'sync', 'slow start', 'quick end', 'slow end'])
})

test("one effect's several disposers run in reverse order, one after another", async t => {
  const marks = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.effect(function* () {
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
  await ctx.fiber.dispose()
  // The last one out is the first to be cleaned up, and each waits for the one before it.
  assert.deepEqual(marks, ['third start', 'third end', 'second', 'first start', 'first end'])
})

test('the returned disposer is idempotent, detaches the effect, and awaiting it does not dispose', async t => {
  const marks = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())

  const counted = ctx.effect(() => () => { marks.push('counted') }, 'counted')
  const first = counted()
  const second = counted()
  assert.equal(first, second, 'a second call hands back the disposal already in flight')
  assert.deepEqual(marks, ['counted'])
  await ctx.fiber.dispose()
  assert.deepEqual(marks, ['counted'], 'an effect disposed early is not disposed again')

  const late = new Context()
  t.after(() => late.fiber.dispose())
  const wrapper = late.effect(() => { marks.push('setup'); return () => marks.push('dispose') }, 'thenable')
  await wrapper
  assert.deepEqual(marks, ['counted', 'setup'])
  assert.deepEqual(late.fiber.getEffects().map(meta => meta.label), ['thenable'])
})

test('registering an effect after the unload fails with the inactive-context error', async () => {
  const { fiber, scope } = await load(inner => {
    inner.effect(() => () => {}, 'live')
  })
  assert.notEqual(fiber.uid, null)
  await fiber.dispose()
  // parts.js:748 reads this to tell an unloaded plugin from a live one.
  assert.equal(fiber.uid, null)
  assert.throws(() => scope.effect(() => () => {}, 'late'), error => {
    assert.equal(error.code, 'INACTIVE_EFFECT')
    assert.equal(error.message, 'cannot create effect on inactive context')
    return true
  })
  // Measured, not asserted here: that message has no "in inactive context" in it, so the
  // second half of the predicate at parts.js:748 never matches this error. Only `uid === null`
  // fires; the regex half belongs to whichever error a service lookup raises instead.
})

test('store.js:336 — the state lock waits for the in-flight write and refuses the ones after it', async () => {
  const marks = []
  let stopped = false
  let writing = Promise.resolve()
  const save = () => {
    if (stopped) {
      marks.push('refused')
      return writing
    }
    marks.push('write start')
    const run = writing.then(async () => {
      await sleep(10)
      marks.push('write end')
    })
    writing = run.catch(() => {})
    return run
  }
  const { fiber } = await load(scope => {
    scope.effect(() => () => {
      stopped = true
      return writing.finally(() => marks.push('lock released'))
    }, 'ds-bot: state lock')
  })
  const inflight = save()
  await fiber.dispose()
  save()
  await Promise.allSettled([inflight, writing])
  assert.deepEqual(marks, ['write start', 'write end', 'lock released', 'refused'])
})

test('capabilities.js:426 — an effect on a nested context goes with that context, and with its parent', async t => {
  const marks = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let outer
  await ctx.plugin(scope => {
    outer = scope
    scope.effect(() => () => marks.push('outer'), 'outer')
  })
  const innerFiber = await outer.plugin(scope => {
    scope.effect(() => () => marks.push('inner'), 'inner')
  })
  await innerFiber.dispose()
  assert.deepEqual(marks, ['inner'])
  assert.equal(innerFiber.uid, null)

  // The real site registers on an Agent's context, which needs a live DSH Session to
  // build; a nested plugin is the same child-fiber machinery and is what is locked here.
  const nested = []
  const root = new Context()
  t.after(() => root.fiber.dispose())
  let parent
  const parentFiber = await root.plugin(scope => {
    parent = scope
    scope.effect(() => () => nested.push('parent'), 'parent')
  })
  const childFiber = await parent.plugin(scope => {
    scope.effect(() => () => nested.push('child'), 'child')
  })
  await parentFiber.dispose()
  assert.equal(childFiber.uid, null)
  // The parent's own effect is synchronous inside its disposer, the child's unload takes
  // one more turn of the event loop, so the parent's line lands first.
  assert.deepEqual(nested, ['parent', 'child'])
})

test('capabilities.js:499 — startup work left running is not awaited, the async disposer is', async () => {
  const marks = []
  let stopped = false
  const { fiber } = await load(scope => {
    scope.effect(() => {
      void sleep(20).then(() => marks.push('load done')).catch(() => marks.push('load failed'))
      return async () => {
        stopped = true
        marks.push('dispose start')
        await sleep(5)
        marks.push('dispose end')
      }
    }, 'ds-bot: capabilities startup')
  })
  await fiber.dispose()
  assert.deepEqual(marks, ['dispose start', 'dispose end'])
  assert.equal(stopped, true)
  await sleep(25)
  assert.deepEqual(marks, ['dispose start', 'dispose end', 'load done'])
})

test('parts.js:298 — a sync disposer puts back what the effect patched over', async () => {
  const marks = []
  const engine = { compact(input) { marks.push(`compact ${input}`) } }
  const { fiber } = await load(scope => {
    scope.effect(() => {
      const original = engine.compact
      engine.compact = function patched(input) { marks.push(`patched ${input}`); return original.call(this, input) }
      return () => { engine.compact = original }
    }, 'ds-bot: adopted engines')
  })
  engine.compact('one')
  await fiber.dispose()
  engine.compact('two')
  assert.deepEqual(marks, ['patched one', 'compact one', 'compact two'])
})

test('diagnostics.js:125 — the stop flag lands before the queued writes are awaited', async () => {
  const marks = []
  let stopped = false
  let writing = Promise.resolve()
  const write = line => {
    const run = writing.then(async () => {
      await sleep(5)
      marks.push(line)
    })
    writing = run.catch(() => {})
    return run
  }
  const { fiber } = await load(scope => {
    scope.effect(() => () => {
      stopped = true
      return writing
    }, 'ds-bot: diagnostics log')
  })
  const queued = [write('first'), write('second')]
  await fiber.dispose()
  await Promise.allSettled(queued)
  assert.deepEqual(marks, ['first', 'second'])
  assert.equal(stopped, true)
})

test('resume.js:386 — the unload clears the pending timer and awaits the write chain', async () => {
  const marks = []
  let stopped = false
  let writing = Promise.resolve()
  const { fiber } = await load(scope => {
    scope.effect(() => {
      const timer = setTimeout(() => marks.push('resumed'), 5)
      timer.unref?.()
      return () => {
        stopped = true
        clearTimeout(timer)
        return writing
      }
    }, 'ds-bot: resume interrupted turns')
  })
  await fiber.dispose()
  await sleep(20)
  assert.deepEqual(marks, [])
  assert.equal(stopped, true)
})

test('usage.js:274 and chat-index.js:127 — a sync disposer closes its resource, a throwing one does not break the unload', async () => {
  const closed = []
  const { fiber } = await load(scope => {
    scope.effect(() => () => closed.push('ledger'), 'ds-bot: usage ledger')
    scope.effect(() => () => closed.push('index'), 'ds-bot: chat index')
    // A close that throws is logged and dropped, so the other two still run.
    scope.effect(() => () => { throw new Error('close failed') }, 'ds-bot: throwing closer')
  })
  await fiber.dispose()
  assert.deepEqual(closed, ['index', 'ledger'])
})

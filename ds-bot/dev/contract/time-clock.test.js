// How our time-context clock behaves next to DSH's own (C0 execution baseline §C0.3): the
// opt-in `dsh-time-context` ships in the Web bundle, so which of the two listeners registers
// first decides whether the user sees one clock or two. test/time-context.test.js covers the
// clock itself without a harness; only this interaction is measured against the real package
// `npm run harness` installs.
//
// Run: node --import ./test/harness-resolve.mjs --test dev/contract/time-clock.test.js
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { install } from '../../src/host/time-context.js'
import { fakeContext } from '../../test/fake-ctx.js'

const NOW = Date.UTC(2026, 9, 12, 4, 30)

test('a loaded DSH clock gets no second clock in either listener order', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  // DSH's opt-in clock ships with the Web bundle, not the base one the plugin resolves from.
  const bundle = join(process.env.DSH_HARNESS, 'packages/bundle/web-app/package.json')
  const { apply: nativeClock } = await import(pathToFileURL(createRequire(bundle).resolve('@deepseek-ai/dsh-time-context')).href)
  const run = async (nativeFirst) => {
    const projections = new Map()
    const ctx = fakeContext({
      services: {
        sessionProjections: {
          register: (definition) => { projections.set(definition.key, definition) },
          stateOf: (_session, key) => projections.get(key)?.init(),
        },
      },
    })
    ctx.sessionProjections = ctx.get('sessionProjections')
    // Prepended listeners run last-registered first.
    ctx.on = (name, listener) => { ctx.listeners.set(name, [listener, ...(ctx.listeners.get(name) ?? [])]) }
    const rt = { ctx, config: { timeZone: 'UTC' }, load: async () => {}, isBotSession: () => true, async* eventsBackwards() {} }
    if (nativeFirst) { nativeClock(ctx, { timeZone: 'UTC' }); install(rt) } else { install(rt); nativeClock(ctx, { timeZone: 'UTC' }) }
    const hooks = ctx.listeners.get('agent/pre-step')
    const payload = { agent: { id: 'bot', session: { seq: 0, eventAt() {} } }, turn: 1, step: 1, signal: new AbortController().signal }
    const user = { role: 'user', content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }
    const invoke = at => at === hooks.length ? { kind: 'enter', messages: [user] } : hooks[at](payload, () => invoke(at + 1))
    return (await invoke(0)).messages.map(message => message.source.kind)
  }
  assert.deepEqual(await run(true), ['user', 'time-context'])
  assert.deepEqual(await run(false), ['user', 'time-context'])
})

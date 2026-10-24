import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { install as installLlm } from '../src/host/llm.js'
import { install as installModels } from '../src/host/models.js'
import { checkKey, install, keyRefFor } from '../src/host/providers.js'

const homes = []
after(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

// A DSH with the official DeepSeek route, an account route, and the pi-ai adapter: its
// directory offers catalog providers, and its settings take path writes the way DSH's
// do, under a revision. Routes come and go with the pi-ai section. The plugin's own
// modules install beside them, so the own directory and its vault are live too.
function dsh({ keys = {}, readOnly = [], user = {}, base = {}, catalog = { anthropic: ['claude-a', 'claude-b'], moonshotai: ['kimi-k3'] }, resolve = undefined } = {}) {
  const store = { ...keys }
  const writes = []
  let revision = 0
  let pi = { user: structuredClone(user), base: structuredClone(base) }
  const piValue = () => ({ providers: { ...pi.base.providers, ...pi.user.providers } })
  const routes = () => Object.keys(piValue().providers)
  const services = {
    settings: {
      describe: () => [
        { ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { ns: 'llm-deepseek-account', revision: 0, value: {}, user: {}, base: {} },
        { ns: 'llm-pi-ai', revision, value: piValue(), user: structuredClone(pi.user), base: structuredClone(pi.base) },
      ],
      mutate: async (ns, ops, expected) => {
        if (expected !== revision) throw new Error(`settings namespace "${ns}" changed since it was read`)
        const next = structuredClone(pi.user)
        for (const op of ops) {
          const parent = op.path.slice(0, -1).reduce((value, key) => (value[key] ??= {}), next)
          if (op.op === 'set') parent[op.path.at(-1)] = op.value
          else delete parent[op.path.at(-1)]
        }
        for (const [id, profile] of Object.entries(next.providers ?? {})) {
          if (!(id in catalog) && !(profile.models?.length > 0)) throw new Error(`llm-pi-ai: provider "${id}" resolves no models`)
        }
        writes.push([ns, ops])
        pi = { ...pi, user: next }
        revision += 1
        // DSH's adapters re-register on a settings change, as the real runtime does.
        emit('llm/adapters-updated')
      },
    },
    credentials: {
      describe: async ref => ({ configured: ref in store, writable: !readOnly.includes(ref) }),
      set: async (ref, value) => { writes.push(['set', ref]); store[ref] = value },
      unset: async (ref) => { writes.push(['unset', ref]); delete store[ref] },
      // Present only when a test asks for it, so the first-start move sees a DSH that
      // cannot read a key back and leaves its routes where their keys work.
      ...(resolve === undefined ? {} : { resolve: async ref => (store[ref] === undefined ? undefined : { value: store[ref], source: 'file' }) }),
    },
  }
  const discovered = []
  // The routes this plugin registered, as the real runtime would serve them.
  const registrations = []
  const ownRoutes = () => registrations.flatMap(entry => entry.providers)
  const dshRoutes = () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'deepseek-account', name: 'DeepSeek Account' }, ...routes().map(id => ({ id, name: piValue().providers[id].displayName ?? id }))]
  const disposers = []
  const listeners = new Map()
  const emit = (name, ...args) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
  const ctx = {
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} },
    effect(execute) { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    get: name => services[name],
    llm: {
      listProviders: () => [...dshRoutes(), ...ownRoutes().map(id => ({ id, name: rt.state.providers[id]?.name ?? id }))],
      listModels: async (id) => {
        if (id === 'deepseek-official') return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]
        if (id === 'deepseek-account') return []
        const profile = piValue().providers[id]
        if (profile !== undefined) return profile.models ?? (catalog[id] ?? []).map(model => ({ id: model }))
        const own = registrations.find(entry => entry.providers.includes(id))
        return own === undefined ? [] : own.adapter.listModels(id)
      },
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
        ...Object.keys(catalog).map(id => ({ provider: id, displayName: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: false })),
        ...routes().filter(id => !(id in catalog)).map(id => ({ provider: id, displayName: piValue().providers[id].displayName ?? id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: true })),
      ],
      registerAdapter(providers, adapter) {
        const taken = [...dshRoutes().map(entry => entry.id), ...ownRoutes()]
        const clash = providers.find(id => taken.includes(id))
        if (clash !== undefined) throw Object.assign(new Error(`duplicate adapter for ${clash}`), { code: 'DUPLICATE_ADAPTER' })
        const entry = { providers: [...providers], adapter }
        registrations.push(entry)
        const handle = () => {}
        handle.replace = next => { entry.providers = [...next] }
        return handle
      },
      discoverModels: async (ns, request) => { discovered.push([ns, request]); return [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, { id: 'relay-2' }] },
    },
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-providers-'))
  homes.push(home)
  const rt = { ctx, state: { bots: {}, providers: {} }, home, warn: () => {}, save: async () => {} }
  installLlm(rt)
  installModels(rt)
  install(rt)
  return { rt, store, writes, listeners, emit, discovered, home }
}

const needing = async rt => (await rt.catalog({ fresh: true })).filter(entry => entry.needsKey).map(entry => entry.provider)
const row = (view, id) => view.providers.find(provider => provider.id === id)

test('models of a provider whose API key is set nowhere need the key', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' }, bedrock: {} } }
  const catalog = { moonshotai: ['kimi-k3'], bedrock: ['nova'] }
  assert.deepEqual(await needing(dsh({ user, catalog }).rt), ['deepseek-official', 'moonshotai'])
  assert.deepEqual(await needing(dsh({ user, catalog, keys: { DEEPSEEK_API_KEY: 'k' } }).rt), ['moonshotai'])
  // A route without a key reference authenticates some other way.
  assert.ok((await dsh({ user, catalog }).rt.catalog()).some(entry => entry.provider === 'bedrock' && !entry.needsKey))
})

test('without DSH settings or credentials no model needs a key, and there is no Models page', async () => {
  const { rt } = dsh()
  rt.ctx.get = () => undefined
  assert.deepEqual(await needing(rt), [])
  const view = await rt.providersView()
  assert.equal(view.available, false)
  assert.deepEqual(view.providers, [])
  assert.deepEqual(view.addable, [])
})

test('the page lists the providers set up and the ones DSH can add', async () => {
  const { rt } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, user: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  const view = await rt.providersView()
  assert.deepEqual(view.providers.map(provider => [provider.id, provider.key, provider.removable, provider.models.length]), [
    ['deepseek-official', { configured: true, writable: true }, false, 1],
    ['moonshotai', { configured: false, writable: true }, true, 1],
  ])
  // The account route has no key and no models before a sign-in.
  assert.equal(row(view, 'deepseek-account'), undefined)
  assert.deepEqual(view.addable, [{ id: 'anthropic', name: 'anthropic' }])
  assert.deepEqual(view.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages'])
})

test('a saved API key goes to the provider\'s reference and frees its models', async () => {
  const { rt, store, writes } = dsh()
  await rt.setProviderKey('deepseek-official', '  sk-test  ')
  assert.deepEqual(writes, [['set', 'DEEPSEEK_API_KEY']])
  assert.equal(store.DEEPSEEK_API_KEY, 'sk-test')
  assert.deepEqual(await needing(rt), [])
  await rt.clearProviderKey('deepseek-official')
  assert.equal('DEEPSEEK_API_KEY' in store, false)
  await assert.rejects(rt.setProviderKey('deepseek-account', 'sk-test'), /deepseek-account takes no API key here/)
})

test('a key set outside DS Bot is not overwritten or removed', async () => {
  const { rt, writes } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, readOnly: ['DEEPSEEK_API_KEY'] })
  await assert.rejects(rt.setProviderKey('deepseek-official', 'sk-test'), /set outside DS Bot/)
  await assert.rejects(rt.clearProviderKey('deepseek-official'), /set outside DS Bot/)
  assert.deepEqual(writes, [])
  assert.deepEqual(row(await rt.providersView(), 'deepseek-official').key, { configured: true, writable: false })
})

test('a provider from DSH\'s list goes in with the key DSH\'s own page would name', async () => {
  const { rt, store, writes } = dsh()
  const view = await rt.addProvider({ provider: 'moonshotai', key: 'sk-kimi' })
  assert.deepEqual(writes, [['llm-pi-ai', [{ op: 'set', path: ['providers', 'moonshotai'], value: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } }]], ['set', 'MOONSHOTAI_API_KEY']])
  assert.equal(store.MOONSHOTAI_API_KEY, 'sk-kimi')
  assert.deepEqual(row(view, 'moonshotai').models.map(model => model.ref), ['moonshotai/kimi-k3'])
  assert.equal(view.addable.some(entry => entry.id === 'moonshotai'), false)
  await assert.rejects(rt.addProvider({ provider: 'moonshotai', key: 'sk-kimi' }), /moonshotai is already set up/)
  await assert.rejects(rt.addProvider({ provider: 'deepseek-official' }), /already set up/)
  await assert.rejects(rt.addProvider({ provider: 'nowhere' }), /DSH offers no provider nowhere/)
})

test('a blank key keeps a key that is already there, else leaves the route without one', async () => {
  const { rt, writes } = dsh({ keys: { ANTHROPIC_API_KEY: 'k' } })
  await rt.addProvider({ provider: 'anthropic', key: '' })
  await rt.addProvider({ provider: 'moonshotai' })
  assert.deepEqual(writes.map(([, ops]) => ops[0].value), [{ apiKeyEnv: 'ANTHROPIC_API_KEY' }, {}])
})

test('a custom API goes in the own directory, with its key in the vault', async () => {
  const { rt, store, writes } = dsh()
  await rt.addProvider({
    custom: true, provider: 'relay', name: ' My relay ', api: 'openai-completions', baseURL: ' https://relay.example/v1 ', key: 'sk-relay',
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, 'relay-2'],
  })
  // DSH's settings and its credential store are not written: the route is this
  // plugin's own now.
  assert.deepEqual(writes, [])
  assert.deepEqual(store, {})
  assert.deepEqual(rt.state.providers.relay, {
    id: 'relay', name: 'My relay', protocol: 'openai-completions', baseURL: 'https://relay.example/v1', keyRef: 'RELAY_API_KEY',
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, input: ['text'] }, { id: 'relay-2' }],
  })
  assert.equal(await rt.ownKeyVault.get('RELAY_API_KEY'), 'sk-relay')
  const row = (await rt.providersView()).providers.find(provider => provider.id === 'relay')
  assert.deepEqual([row.name, row.custom, row.removable, row.key], ['My relay', true, true, { configured: true, writable: true }])
  assert.deepEqual(row.models.map(model => model.ref), ['relay/relay-1', 'relay/relay-2'])
  assert.equal(await rt.removeOwnProvider('relay'), true)
  assert.equal(rt.state.providers.relay, undefined)
  assert.equal(await rt.ownKeyVault.get('RELAY_API_KEY'), undefined)
})

test('a custom API is refused before anything is written when it cannot serve', async () => {
  const { rt, writes } = dsh()
  const custom = { custom: true, provider: 'relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', models: ['m'] }
  await assert.rejects(rt.addProvider({ ...custom, provider: 'My Relay' }), /lowercase words separated by single dashes/)
  await assert.rejects(rt.addProvider({ ...custom, provider: 'anthropic' }), /DSH already offers anthropic/)
  await assert.rejects(rt.addProvider({ ...custom, api: 'grpc' }), /protocol must be one of/)
  await assert.rejects(rt.addProvider({ ...custom, baseURL: 'relay.example' }), /http or https/)
  await assert.rejects(rt.addProvider({ ...custom, baseURL: 'ftp://relay.example' }), /http or https/)
  await assert.rejects(rt.addProvider({ ...custom, models: [] }), /at least one model/)
  await assert.rejects(rt.addProvider({ ...custom, models: ['m', ' m '] }), /same id/)
  await assert.rejects(rt.addProvider({ ...custom, key: 'KEY=sk' }), /NAME=value/)
  assert.deepEqual(writes, [])
  assert.deepEqual(rt.state.providers, {})
})

test('fetching models asks the endpoint itself, with the typed key for that question only', async () => {
  const asked = []
  const server = createServer((req, res) => {
    asked.push({ url: req.url, authorization: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'relay-1' }, { id: 'relay-2', name: 'Relay Two' }] }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { rt, store, discovered } = dsh()
  try {
    const models = await rt.discoverModels({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', key: 'sk-relay' })
    assert.deepEqual(asked, [{ url: '/v1/models', authorization: 'Bearer sk-relay' }])
    assert.deepEqual(models, [{ id: 'relay-1' }, { id: 'relay-2', name: 'Relay Two' }])
    // The typed key is not stored, and DSH is not asked about a custom endpoint.
    assert.deepEqual(store, {})
    assert.deepEqual(discovered, [])
    // A provider DSH ships is answered from its own catalog.
    await rt.discoverModels({ provider: 'anthropic' })
    assert.deepEqual(discovered.at(-1), ['llm-pi-ai', { provider: 'anthropic' }])
  } finally {
    await new Promise(done => server.close(done))
  }
})

test('removing a provider takes its key along unless another provider names it', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' }, kimi: { apiKeyEnv: 'MOONSHOTAI_API_KEY', api: 'openai-completions', baseURL: 'https://k.example/v1', models: [{ id: 'k' }] }, relay: { apiKeyEnv: 'RELAY_API_KEY', api: 'openai-completions', baseURL: 'https://r.example/v1', models: [{ id: 'r' }] } } }
  const { rt, store } = dsh({ user, keys: { MOONSHOTAI_API_KEY: 'a', RELAY_API_KEY: 'b' } })
  await rt.removeProvider('moonshotai')
  assert.equal(store.MOONSHOTAI_API_KEY, 'a')
  const view = await rt.removeProvider('relay')
  assert.equal('RELAY_API_KEY' in store, false)
  assert.deepEqual(view.providers.map(provider => provider.id), ['deepseek-official', 'kimi'])
  await assert.rejects(rt.removeProvider('relay'), /relay is not set up/)
  await assert.rejects(rt.removeProvider('deepseek-official'), /not set up/)
})

test('a route that comes with the setup stays', async () => {
  const { rt } = dsh({ base: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  assert.equal(row(await rt.providersView(), 'moonshotai').removable, false)
  await assert.rejects(rt.removeProvider('moonshotai'), /comes with this setup/)
})

test('a changed credential drops the cached catalog', async () => {
  const { rt, store, emit } = dsh()
  assert.deepEqual(await needing(rt), ['deepseek-official'])
  store.DEEPSEEK_API_KEY = 'k'
  assert.deepEqual((await rt.catalog()).filter(entry => entry.needsKey).map(entry => entry.provider), ['deepseek-official'])
  emit('credentials/reference-updated')
  assert.deepEqual((await rt.catalog()).filter(entry => entry.needsKey).map(entry => entry.provider), [])
})

test('the first start moves a custom route from DSH\'s settings into the own directory', async () => {
  const { rt, store, writes } = dsh({
    resolve: true,
    keys: { RELAY_API_KEY: 'sk-relay', MOONSHOTAI_API_KEY: 'sk-kimi' },
    user: {
      providers: {
        relay: { displayName: 'My relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY', models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000 }] },
        // A catalog provider's key row carries no endpoint or models of its own.
        moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' },
      },
    },
  })
  await rt.moveOwnProviders()
  assert.deepEqual(rt.state.providers.relay, {
    id: 'relay', name: 'My relay', protocol: 'openai-completions', baseURL: 'https://relay.example/v1', keyRef: 'RELAY_API_KEY',
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000 }],
  })
  assert.equal(await rt.ownKeyVault.get('RELAY_API_KEY'), 'sk-relay')
  // DSH's settings no longer hold the route; its credential store keeps the key.
  assert.deepEqual(writes.filter(([ns]) => ns === 'llm-pi-ai').map(([, ops]) => ops), [[{ op: 'unset', path: ['providers', 'relay'] }]])
  assert.equal(store.RELAY_API_KEY, 'sk-relay')
  // The catalog provider's row stayed, and it is listed as DSH's own.
  assert.equal(row(await rt.providersView(), 'moonshotai').custom, false)
  // Once only: asking again changes nothing.
  assert.deepEqual(rt.state.providersMoved, true)
  const before = JSON.stringify(rt.state.providers)
  await rt.moveOwnProviders()
  assert.equal(JSON.stringify(rt.state.providers), before)
})

test('a route DSH cannot read a key back for stays where its key works', async () => {
  const { rt, writes } = dsh({
    user: { providers: { relay: { api: 'openai-completions', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY', models: ['relay-1'] } } },
  })
  await rt.moveOwnProviders()
  assert.deepEqual(rt.state.providers, {})
  assert.deepEqual(writes, [])
  assert.deepEqual(rt.state.providersMoved, true)
})

test('an API key is what an HTTP header carries, without a NAME= or quotes', () => {
  assert.equal(checkKey(' sk-abc '), 'sk-abc')
  assert.equal(checkKey('YWJj=='), 'YWJj==')
  assert.throws(() => checkKey('   '), /Enter the API key/)
  assert.throws(() => checkKey(undefined), /Enter the API key/)
  assert.throws(() => checkKey('DEEPSEEK_API_KEY=sk-abc'), /not a NAME=value line/)
  assert.throws(() => checkKey('"sk-abc"'), /without quotes/)
  assert.throws(() => checkKey('sk abc'), /no spaces/)
  assert.throws(() => checkKey('sk-密钥'), /no spaces/)
})

test('a route\'s key reference follows DSH\'s own Models page', () => {
  assert.equal(keyRefFor('moonshotai'), 'MOONSHOTAI_API_KEY')
  assert.equal(keyRefFor('my-gateway2'), 'MY_GATEWAY2_API_KEY')
})

const own = { custom: true, provider: 'relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', models: ['relay-1'] }

test('an own route\'s key goes to the vault, and its models need it until it is set', async () => {
  const { rt, writes } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' } })
  await rt.addProvider(own)
  // The DSH route has its key; the own route has none yet.
  assert.deepEqual((await needing(rt)).sort(), ['relay'])
  await rt.setProviderKey('relay', ' sk-relay ')
  assert.deepEqual(await needing(rt), [])
  assert.deepEqual(row(await rt.providersView(), 'relay').key, { configured: true, writable: true })
  await rt.clearProviderKey('relay')
  assert.deepEqual(await needing(rt), ['relay'])
  // Nothing of it touched DSH's settings or its credential store.
  assert.deepEqual(writes, [])
})

test('the Models page lists the own routes beside DSH\'s', async () => {
  const { rt } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, user: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  await rt.addProvider(own)
  const view = await rt.providersView()
  assert.deepEqual(view.providers.map(provider => [provider.id, provider.custom]), [
    ['deepseek-official', false],
    ['relay', true],
    ['moonshotai', false],
  ])
  await assert.rejects(rt.addProvider({ ...own, provider: 'relay' }), /relay is already set up/)
  await assert.rejects(rt.removeProvider('deepseek-official'), /not set up/)
})

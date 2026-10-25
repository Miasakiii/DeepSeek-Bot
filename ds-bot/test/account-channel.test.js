import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { install as installChannel } from '../src/host/channel.js'
import { fakeContext } from './fake-ctx.js'

// The DeepSeek account endpoints of the api/bot channel, through DSH's documented
// account service. The service here is a stand-in with that service's signatures; its
// views carry no token, and neither may the channel's answers.

const LINKS = { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/top' }
const OUT = { status: 'signed-out', links: LINKS, attempt: null }
const WAITING = { status: 'signed-out', links: LINKS, attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize', expiresAt: 1893456000000 } }

// A stand-in for `ctx.deepseekAccount` (dsh-deepseek-account's service): the states it
// reports, its calls recorded, and `watch` yielding a snapshot per change until the
// subscription ends.
function fakeAccount(initial = OUT) {
  const calls = []
  const waiting = []
  let state = initial
  const wake = () => { for (const one of waiting.splice(0)) one() }
  return {
    calls,
    set(next) { state = next; wake() },
    async getState() { calls.push(['getState']); return state },
    async startSignIn(client, callbackOrigin, loginSource) {
      calls.push(['startSignIn', client, callbackOrigin, loginSource])
      state = WAITING
      return state
    },
    async cancelSignIn(id) { calls.push(['cancelSignIn', id]); state = { ...OUT, attempt: { id: 'a1', phase: 'cancelled' } }; return state },
    async signOut(client) { calls.push(['signOut', client]); state = OUT; return state },
    watch(signal) {
      return (async function* () {
        yield state
        while (!signal.aborted) {
          await new Promise((resolve) => {
            if (signal.aborted) return resolve()
            waiting.push(resolve)
            signal.addEventListener('abort', resolve, { once: true })
          })
          if (signal.aborted) return
          yield state
        }
      })()
    },
  }
}

// The channel alone, as thinking.test.js drives it: which endpoints a read-only host
// still answers. The account functions stand in for the account module's.
function channel({ readOnly = undefined } = {}) {
  let route
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on: () => () => {},
    effect: execute => { execute() },
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
  }
  const rt = {
    ctx,
    state: { revision: 0, bots: {}, rooms: {}, exchanges: [], questions: {}, agents: {}, secretRequests: {}, prefs: {} },
    save: async () => {},
    refresh: async () => {},
    readOnly: () => readOnly,
    load: async () => {},
    bootstrap: async () => {},
    catalog: async () => {},
    loadSecrets: async () => {},
    cachedCatalog: () => [],
    cachedDefault: () => undefined,
    reasoningOf: () => undefined,
    providersView: async () => ({}),
    accountView: async () => ({ available: true, state: OUT }),
    accountStart: async () => ({ status: 'signed-out' }),
    secretsView: () => ({}),
    capabilityLibraryView: () => ({}),
    activityView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    approvalsView: () => ({}),
    waitingView: () => ({}),
    turnsView: () => ({}),
    memoryNews: () => ({}),
    memoryReviews: () => ({}),
    connectorsView: () => ({}),
    capabilityStatusesView: () => ({}),
    selfOf: () => undefined,
    warn() {},
  }
  installChannel(rt)
  const post = async (endpoint, payload) => {
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return response.json()
  }
  return { post }
}

test('a host that only reads the team still answers the account state, but changes nothing', async () => {
  const { post } = channel({ readOnly: 'another dsh holds this team' })
  assert.equal((await post('account-state', {})).ok, true)
  const refused = await post('account-sign-in', {})
  assert.deepEqual([refused.ok, refused.error.code], [false, 'bot/read-only'])
})

// The whole plugin on a fake context, so the account module and the feed run with the
// channel, as in a real host. `account: null` or `webServer: null` leaves the service
// out, as a DSH without it would.
function host({ account = fakeAccount(), webServer = { getOrigin: () => 'http://127.0.0.1:4567' } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-account-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['m1'], revision: 3, bots: { m1: { id: 'm1', sessionId: 'm1c', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1 } }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} }))
  const ctx = fakeContext({ services: {
    ...(account === null ? {} : { deepseekAccount: account }),
    ...(webServer === null ? {} : { webServer }),
  } })
  ctx.sessionController = { resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 100 } } }), page: async () => ({ records: [], hasMore: false }) }
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, stop, routes }
}

function reader(response) {
  const source = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(':')) continue
        const field = name => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
        return { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

test('account-state answers what the service reports, with no token in it', async (t) => {
  const account = fakeAccount(WAITING)
  const { call, stop } = host({ account })
  t.after(stop)
  await call('state')
  const answer = await call('account-state', {})
  assert.deepEqual(answer, { ok: true, value: { available: true, state: { status: 'signed-out', links: LINKS, attempt: WAITING.attempt } } })
  assert.equal(JSON.stringify(answer).includes('token'), false)
})

test('account-sign-in starts the browser login with the web server as its callback origin', async (t) => {
  const account = fakeAccount()
  const { call, stop } = host({ account })
  t.after(stop)
  await call('state')
  const answer = await call('account-sign-in', { locale: 'zh-CN', timezoneOffsetSeconds: -28800 })
  assert.equal(answer.ok, true)
  assert.equal(answer.value.attempt.phase, 'waiting-browser')
  const [name, client, origin, loginSource] = account.calls.find(([what]) => what === 'startSignIn')
  assert.equal(name, 'startSignIn')
  assert.deepEqual([origin, loginSource], ['http://127.0.0.1:4567', 'desktop'])
  assert.equal(typeof client.version, 'string')
  assert.deepEqual([client.locale, client.timezoneOffsetSeconds], ['zh-CN', -28800])
})

// The service starts a fresh authorization whatever a stored login says and the new
// grant replaces it, so the host answers a signed-in account with its own state.
test('a stored login is not replaced: the sign-in answers the state the service holds', async (t) => {
  const account = fakeAccount({ ...OUT, status: 'credential-stored' })
  const { call, stop } = host({ account })
  t.after(stop)
  await call('state')
  const answer = await call('account-sign-in', { locale: 'zh-CN', timezoneOffsetSeconds: -28800 })
  assert.equal(answer.ok, true)
  assert.equal(answer.value.status, 'credential-stored')
  assert.equal(answer.value.attempt, null)
  assert.equal(account.calls.some(([what]) => what === 'startSignIn'), false)
})

test('without the account service or the web server the channel says what is missing', async (t) => {
  const noService = host({ account: null })
  t.after(noService.stop)
  await noService.call('state')
  // A missing service is a state of its own, not a failure: the window shows no entry.
  assert.deepEqual(await noService.call('account-state', {}), { ok: true, value: { available: false, state: null } })
  const start = await noService.call('account-sign-in', {})
  assert.deepEqual([start.ok, start.error.code], [false, 'bot/unavailable'])
  assert.match(start.error.message, /account service/)

  const noServer = host({ webServer: null })
  t.after(noServer.stop)
  await noServer.call('state')
  assert.equal((await noServer.call('account-state', {})).value.available, true)
  const refused = await noServer.call('account-sign-in', {})
  assert.deepEqual([refused.ok, refused.error.code], [false, 'bot/unavailable'])
  assert.match(refused.error.message, /web server/)
})

test('account-cancel carries the attempt id and account-sign-out the client identity', async (t) => {
  const account = fakeAccount(WAITING)
  const { call, stop } = host({ account })
  t.after(stop)
  await call('state')
  await call('account-cancel', { id: 'a1' })
  await call('account-sign-out', { locale: 'en-US', timezoneOffsetSeconds: 3600 })
  assert.deepEqual(account.calls.filter(([what]) => what === 'cancelSignIn').map(([, id]) => id), ['a1'])
  const [, client] = account.calls.find(([what]) => what === 'signOut')
  assert.deepEqual([client.locale, client.timezoneOffsetSeconds], ['en-US', 3600])
  assert.equal(typeof client.version, 'string')
})

test('the feed carries the account news to the windows', async (t) => {
  const account = fakeAccount(WAITING)
  const { call, stop, routes } = host({ account })
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  // The watch's first snapshot went out at start-up, before this window joined; every
  // change after it is one account event.
  account.set({ ...OUT, status: 'credential-stored' })
  assert.deepEqual(await next(), { event: 'account', data: { ...OUT, status: 'credential-stored' } })
  account.set(WAITING)
  assert.deepEqual(await next(), { event: 'account', data: WAITING })
})

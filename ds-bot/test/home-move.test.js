import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A team an earlier build left in the upstream `bot/` folder, opened by this one: the
// folder moves to this plugin's own name before anything reads the state.
function open({ legacy = true, own = false, held = false, home: customHome } = {}) {
  const dshHome = mkdtempSync(join(tmpdir(), 'ds-bot-home-'))
  const env = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const saved = prefs => ({ version: 1, mainBotIds: [], bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs, revision: 3 })
  const legacyHome = join(dshHome, 'bot')
  const ownHome = join(dshHome, 'miasaki-dsbot')
  if (legacy) {
    mkdirSync(legacyHome, { recursive: true })
    writeFileSync(join(legacyHome, 'state.json'), JSON.stringify(saved({ theme: 'grok' })))
    if (held) writeFileSync(join(legacyHome, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host', since: Date.now() }))
  }
  if (own) {
    mkdirSync(ownHome, { recursive: true })
    writeFileSync(join(ownHome, 'state.json'), JSON.stringify(saved({ theme: 'paper' })))
  }
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, customHome === undefined ? {} : { home: customHome })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    if (env === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = env
    rmSync(dshHome, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, dshHome, legacyHome, ownHome }
}

test('a team left in the upstream bot folder moves to this plugin\'s own folder', async (t) => {
  const { call, stop, legacyHome, ownHome } = open()
  t.after(stop)
  assert.equal(existsSync(legacyHome), false)
  assert.equal(existsSync(join(ownHome, 'state.json')), true)
  // The moved team is the one that opens: its legacy theme is migrated on the read.
  const team = (await call('state', {})).value
  assert.deepEqual(team.prefs, { theme: 'mono' })
  assert.equal(JSON.parse(readFileSync(join(ownHome, 'state.json'), 'utf8')).prefs.theme, 'mono')
})

test('a team of this plugin\'s own keeps the upstream folder where it is', async (t) => {
  const { call, stop, legacyHome } = open({ own: true })
  t.after(stop)
  assert.equal(existsSync(join(legacyHome, 'state.json')), true)
  assert.equal((await call('state', {})).value.prefs.theme, 'paper')
})

test('another dsh holding the team keeps this one out of the upstream folder', async (t) => {
  const { call, stop, legacyHome, ownHome } = open({ held: true })
  t.after(stop)
  // This plugin starts its own team instead of reading the other one's.
  const team = (await call('state', {})).value
  assert.notEqual(team.prefs.theme, 'mono')
  assert.equal(existsSync(join(ownHome, 'state.json')), true)
  // The other dsh's team is left as it is.
  assert.equal(JSON.parse(readFileSync(join(legacyHome, 'state.json'), 'utf8')).prefs.theme, 'grok')
})

test('a home of its own moves nothing', async (t) => {
  const custom = mkdtempSync(join(tmpdir(), 'ds-bot-custom-'))
  t.after(() => rmSync(custom, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop, legacyHome } = open({ home: custom })
  t.after(stop)
  await call('state', {})
  assert.equal(existsSync(join(legacyHome, 'state.json')), true)
  assert.equal(existsSync(join(custom, 'state.json')), true)
})

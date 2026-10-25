import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { claimBundles, DSH_WINDOW_BUNDLES, loadAppProfile, loadCheckProfile, OWN_WINDOW_BUNDLES, ownServicesPatchRows } from '../src/profile.mjs'

// Packages of DSH's own Web front end and its browser runtime, which the rollback window shows.
const DSH_WEB_FRONT_END = /^@deepseek-ai\/dsh-(client-ui-|web-app|web-frontend|client-modules|host-frontend-static|cordis-client-runner|client-hmr)/u

// Every row of an entry list, with the rows inside groups and agent presets.
function rows(entries) {
  return entries.flatMap((entry) => [
    entry,
    ...rows(Array.isArray(entry.config) ? entry.config : []),
    ...rows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])
}

const compose = (profile, patches = []) => composeEntries([...profile.layers.map((layer) => layer.patches), ...patches])
const enabled = (entries) => new Set(entries.filter((entry) => entry.disabled !== true).map((entry) => entry.id))

describe('the app profile with the own window', () => {
  let home
  let profile
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-profile-'))
    process.env.DSH_HOME = home
    profile = loadAppProfile(true)
    assert.deepEqual(profile.layers.map((layer) => layer.packageName), OWN_WINDOW_BUNDLES)
    assert.deepEqual(profile.skippedBundles, [])
  })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('mounts no DSH Web of its own: no front end, and its services only through the overlay', () => {
    const entries = compose(profile)
    const on = enabled(entries)
    for (const id of ['webserver', 'web-runtime', 'connection', 'modules']) assert.ok(!on.has(id), `${id} is not mounted`)
    assert.ok(!rows(entries).some((entry) => DSH_WEB_FRONT_END.test(entry.name ?? '')), 'the DSH Web front end is not mounted')
  })

  test('mounts the Bot team as DSH Web does', () => {
    const on = enabled(compose(profile))
    for (const id of ['miasaki-bot', 'miasaki-web-search']) assert.ok(on.has(id), `${id} is mounted`)
  })

  test("carries the front end's services through the own overlay, and the OAuth callback's web server", () => {
    const entries = compose(profile, ownServicesPatchRows())
    const on = enabled(entries)
    for (const id of ['workspace', 'session-controller', 'connection', 'file-upload', 'webserver']) assert.ok(on.has(id), `${id} is mounted`)
    for (const id of ['web-runtime', 'modules']) assert.ok(!on.has(id), `${id} stays out`)
    assert.ok(!rows(entries).some((entry) => DSH_WEB_FRONT_END.test(entry.name ?? '')), 'the DSH Web front end is not mounted')
    // The web server only takes the account sign-in's loopback callback: a loopback
    // address, a port the system picks, and no front end riding on it.
    const server = rows(entries).find((entry) => entry.id === 'webserver')
    assert.deepEqual(server.config, { host: '127.0.0.1', port: 0 })
  })
})

describe('the app profile with the rollback window (DS_BOT_OWN_UI=0)', () => {
  let home
  let entries
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-profile-'))
    process.env.DSH_HOME = home
    const profile = loadAppProfile(false)
    assert.deepEqual(profile.layers.map((layer) => layer.packageName), DSH_WINDOW_BUNDLES)
    assert.deepEqual(profile.skippedBundles, [])
    entries = compose(profile)
  })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('mounts DSH Web, which the window shows, and the Bot team', () => {
    const on = enabled(entries)
    for (const id of ['webserver', 'connection', 'miasaki-bot', 'miasaki-web-search']) assert.ok(on.has(id), `${id} is mounted`)
    assert.ok(rows(entries).some((entry) => DSH_WEB_FRONT_END.test(entry.name ?? '')), 'the DSH Web front end is mounted')
  })

  test("the own window's overlay names the packages of the stock rows it stands in for", () => {
    const stock = new Map(entries.filter((entry) => ['workspace', 'session-controller', 'connection', 'file-upload'].includes(entry.id)).map((entry) => [entry.id, entry.name]))
    assert.deepEqual(ownServicesPatchRows(), [{ insert: [
      { id: 'workspace', name: stock.get('workspace') },
      { id: 'session-controller', name: stock.get('session-controller') },
      { id: 'connection', name: stock.get('connection') },
      { id: 'file-upload', name: stock.get('file-upload') },
      // The web server the rollback mode mounts through the front end; here it only
      // listens for the account sign-in's loopback callback.
      { id: 'webserver', name: entries.find((entry) => entry.id === 'webserver').name, config: { host: '127.0.0.1', port: 0 } },
    ] }])
  })
})

describe('the first-run check profile', () => {
  let home
  before(() => { home = mkdtempSync(join(tmpdir(), 'ds-bot-app-check-profile-')) })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('reads the Sessions on DSH\'s shared core alone', () => {
    process.env.DSH_HOME = home
    const profile = loadCheckProfile()
    assert.deepEqual(profile.layers.map((layer) => layer.packageName), ['@deepseek-ai/dsh-base'])
    assert.deepEqual(profile.skippedBundles, [])
  })
})

describe('claimBundles', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'ds-bot-app-bundles-')) })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (bundles) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-ds-bot', private: true, dependencies: { 'a-plugin': '1.0.0' }, dsh: { profile: { bundles } } }, undefined, 2)}\n`)
  }
  const read = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  test('puts the mode\'s bundles first, keeps the user bundles and drops the retired ones', () => {
    write(['@deepseek-ai/dsh-base', 'deepseek-bot-engine', '@deepseek-ai/dsh-web-app', 'miasaki-dsbot', 'a-plugin'])
    claimBundles(dir, OWN_WINDOW_BUNDLES)
    assert.deepEqual(read().dsh.profile.bundles, [...OWN_WINDOW_BUNDLES, 'a-plugin'])
    assert.deepEqual(read().dependencies, { 'a-plugin': '1.0.0' })
  })

  test('puts the front end back when the window rolls back', () => {
    write(['@deepseek-ai/dsh-base', 'miasaki-dsbot', 'a-plugin'])
    claimBundles(dir, DSH_WINDOW_BUNDLES)
    assert.deepEqual(read().dsh.profile.bundles, [...DSH_WINDOW_BUNDLES, 'a-plugin'])
  })

  test('leaves a profile that already lists the mode\'s bundles alone', () => {
    for (const bundles of [DSH_WINDOW_BUNDLES, OWN_WINDOW_BUNDLES]) {
      write([...bundles, 'a-plugin'])
      const before = readFileSync(join(dir, 'package.json'), 'utf8')
      claimBundles(dir, bundles)
      assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
    }
  })
})

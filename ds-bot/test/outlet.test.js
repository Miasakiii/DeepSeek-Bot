import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The plugin with its own HTTP outlet on a free port, beside the DSH connection route.
// The token is fixed, so a test authenticates without reading the start-up line.
async function start({ root } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-outlet-'))
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, outletPort: 0, outletToken: 'test-token', ...(root === undefined ? {} : { outletRoot: root }) })
  const { port } = await rt.outletReady()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, stop, base: `http://127.0.0.1:${port}`, token: 'test-token' }
}

const post = (base, token, endpoint, payload) => fetch(`${base}/api/bot`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify({ endpoint, payload }),
}).then(async response => ({ status: response.status, body: await response.json() }))

test('the outlet stays off until the config names a port', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-outlet-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const rt = createRuntime(fakeContext(), { home })
  assert.equal(rt.outletReady, undefined)
  assert.equal(rt.outletPort, undefined)
})

test('the outlet answers the channel over its own port, with the token it prints', async (t) => {
  const { stop, base, token } = await start()
  t.after(stop)
  // Without the token the channel is not reachable at all.
  assert.equal((await post(base, null, 'state', {})).status, 401)
  assert.equal((await post(base, 'wrong', 'state', {})).status, 401)
  // With it, the same team view the DSH route serves comes back.
  const answer = await post(base, token, 'state', {})
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.ok(Array.isArray(answer.body.value.bots))
  // An unknown endpoint answers the channel's own refusal.
  const missing = await post(base, token, 'nope', {})
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.error.code, 'bot/not-found')
})

test('the outlet streams the feed over its own port', async (t) => {
  const { stop, base, token } = await start()
  t.after(stop)
  // An EventSource cannot set a header, so the token rides in the query.
  const response = await fetch(`${base}/api/bot/feed?token=${token}`, { headers: { accept: 'text/event-stream' } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const first = await reader.read()
  const hello = new TextDecoder().decode(first.value)
  assert.match(hello, /^event: hello\ndata: \{"revision":\d+\}/)
  await reader.cancel()
  assert.equal((await fetch(`${base}/api/bot/feed`)).status, 401)
})

test('an answer starts a session cookie, so a reload needs no token in the URL', async (t) => {
  const { stop, base, token } = await start()
  t.after(stop)
  const ask = (headers) => fetch(`${base}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ endpoint: 'state', payload: {} }),
  })
  const answer = await ask({ authorization: `Bearer ${token}` })
  const jar = answer.headers.getSetCookie().map(part => part.split(';')[0])
  assert.equal(jar.length, 1)
  assert.match(jar[0], /^dsbot-outlet=/)
  // A window that reloaded has the cookie and no token in its address bar.
  const again = await ask({ cookie: jar.join('; ') })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).ok, true)
  // A refusal starts no session.
  assert.equal(answer.headers.getSetCookie().length, 1)
  const refused = await post(base, null, 'state', {})
  assert.equal(refused.status, 401)
})

test('the outlet serves the window files it is pointed at, and nothing outside them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-outlet-www-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>own window</title>')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  const { stop, base, token } = await start({ root })
  t.after(stop)
  const index = await fetch(`${base}/?token=${token}`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type'), /text\/html/)
  assert.match(await index.text(), /own window/)
  // The document a window opens with its token is its first answer; the page's own asset
  // requests ride the session it starts, with no token of their own.
  const jar = index.headers.getSetCookie().map(part => part.split(';')[0])
  assert.match(jar[0] ?? '', /^dsbot-outlet=/)
  const riding = await fetch(`${base}/assets/app.js`, { headers: { cookie: jar.join('; ') } })
  assert.equal(riding.status, 200)
  assert.equal(await riding.text(), 'console.log(1)')
  const script = await fetch(`${base}/assets/app.js?token=${token}`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type'), /javascript/)
  assert.equal(await script.text(), 'console.log(1)')
  // A path that climbs out of the served folder is refused, and a missing file is a 404.
  const escaped = await fetch(`${base}/../package.json?token=${token}`)
  assert.equal([403, 404].includes(escaped.status), true)
  assert.equal((await fetch(`${base}/nope.js?token=${token}`)).status, 404)
})

test('the outlet without a file root answers 404 for files', async (t) => {
  const { stop, base, token } = await start()
  t.after(stop)
  assert.equal((await fetch(`${base}/index.html?token=${token}`)).status, 404)
  // The token is checked before the route, so an unknown method without one is a 401.
  assert.equal((await fetch(`${base}/api/bot`, { method: 'PUT' })).status, 401)
  assert.equal((await fetch(`${base}/api/bot`, { method: 'PUT', headers: { authorization: `Bearer ${token}` } })).status, 404)
})

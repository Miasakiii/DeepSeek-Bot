import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { outletOrigin, outletPatchRows, outletPlan, outletUp, outletUrl } from '../src/outlet.mjs'

const root = mkdtempSync(join(tmpdir(), 'ds-bot-app-outlet-'))
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); mkdirSync(root, { recursive: true }) })

const buildAt = () => {
  const uiRoot = join(root, 'ui', 'dist')
  mkdirSync(uiRoot, { recursive: true })
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html>')
  return uiRoot
}

test('the own window is off when the build is missing or the rollback is asked for', async () => {
  const uiRoot = join(root, 'missing')
  assert.equal(await outletPlan(join(root, 'userData'), uiRoot), undefined)
  const built = buildAt()
  process.env.DS_BOT_OWN_UI = '0'
  try {
    assert.equal(await outletPlan(join(root, 'userData'), built), undefined)
  } finally {
    delete process.env.DS_BOT_OWN_UI
  }
})

test('the outlet takes a stable port and a fresh token at every start', async () => {
  const userData = join(root, 'userData')
  const uiRoot = buildAt()
  const first = await outletPlan(userData, uiRoot)
  assert.equal(first.port, await outletPlan(userData, uiRoot).then(plan => plan.port))
  assert.notEqual(first.token, (await outletPlan(userData, uiRoot)).token)
  assert.equal(first.root, uiRoot)
  assert.equal(outletOrigin(first), `http://127.0.0.1:${first.port}`)
  assert.equal(outletUrl(first), `${outletOrigin(first)}/?token=${first.token}`)
})

test('the profile patch points the plugin at the outlet', () => {
  const rows = outletPatchRows({ port: 4321, token: 't', root: '/tmp/ui/dist' })
  assert.deepEqual(rows, [{ id: 'miasaki-bot', name: 'miasaki-dsbot', config: { outletPort: 4321, outletToken: 't', outletRoot: '/tmp/ui/dist' } }])
})

test('the outlet is up once it answers a connection, and not before', async () => {
  const server = createServer()
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  assert.equal(await outletUp(port, 2000), true)
  await new Promise((resolve) => { server.close(resolve) })
  assert.equal(await outletUp(port, 300), false)
})

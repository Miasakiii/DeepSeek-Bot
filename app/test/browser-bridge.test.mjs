import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserBridge, PARTITION_PREFIX } from '../src/browser-bridge.cjs'

// Only what the bridge asks of a document: capture-phase listeners.
class FakeDocument {
  constructor() { this.listeners = new Map() }
  addEventListener(type, listener, capture) {
    if (!capture) return
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  dispatch(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event)
  }
}

// A `<webview>` element carries its lease in the name attribute.
const guest = name => ({ getAttribute: key => (key === 'name' ? name : null) })

const newWindowEvent = (target) => {
  const event = { type: 'new-window', url: 'https://example.com/', target, defaultPrevented: false }
  event.preventDefault = () => { event.defaultPrevented = true }
  return event
}

test('one Bot always gets the same partition, made safe for a file name', async () => {
  const bridge = createBrowserBridge({ document: new FakeDocument(), randomId: () => 'x' })
  assert.equal(bridge.protocolVersion, 1)
  const whale = await bridge.browser.acquire('bot:whale')
  assert.equal(whale.partition, `${PARTITION_PREFIX}bot_whale`)
  assert.equal((await bridge.browser.acquire('bot:whale')).partition, whale.partition)
  // Several pages of the same Bot hold distinct leases.
  assert.notEqual((await bridge.browser.acquire('bot:whale')).lease, whale.lease)
  // Another Bot gets its own partition, and unsafe characters do not reach the file name.
  assert.equal((await bridge.browser.acquire('bot:dolphin')).partition, `${PARTITION_PREFIX}bot_dolphin`)
  assert.equal((await bridge.browser.acquire('///')).partition, `${PARTITION_PREFIX}_`)
  assert.equal((await bridge.browser.acquire('')).partition, `${PARTITION_PREFIX}unknown`)
})

test('a guest that asks for a new window reaches its own Bot, and nobody else', async () => {
  const document = new FakeDocument()
  const bridge = createBrowserBridge({ document, randomId: () => 'x' })
  const { lease } = await bridge.browser.acquire('bot:whale')
  const heard = []
  const stop = bridge.browser.onOpenRequested(lease, url => heard.push(url))
  const asked = newWindowEvent(guest(lease))
  document.dispatch(asked)
  assert.deepEqual(heard, ['https://example.com/'])
  assert.equal(asked.defaultPrevented, true)
  // A guest whose Bot no longer listens (its tab closed) changes nothing.
  const stranger = newWindowEvent(guest('lease-9-nobody'))
  document.dispatch(stranger)
  assert.equal(stranger.defaultPrevented, false)
  assert.deepEqual(heard, ['https://example.com/'])
  // Nor does a guest after its Bot stops listening.
  stop()
  document.dispatch(newWindowEvent(guest(lease)))
  assert.deepEqual(heard, ['https://example.com/'])
})

test('release leaves nothing behind, but still resolves', async () => {
  const bridge = createBrowserBridge({ document: new FakeDocument(), randomId: () => 'x' })
  await bridge.browser.release((await bridge.browser.acquire('bot:whale')).lease)
})

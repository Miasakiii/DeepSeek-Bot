import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The own sign-in dialog bundled once and rendered with a stateful stand-in React that
// also runs effects with their dependencies, so the dialog's phases — the host's
// attempt answers — drive what it shows.
const { outputFiles } = await build({
  stdin: {
    contents: "export { OwnSignInDialog } from './src/client/account-dialog.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
const effectSlots = []
let cursor = 0
let effectCursor = 0
let pending = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState(initial) {
    const i = cursor++
    if (slots[i] === undefined) slots[i] = { v: typeof initial === 'function' ? initial() : initial }
    const slot = slots[i]
    return [slot.v, v => { slot.v = typeof v === 'function' ? v(slot.v) : v }]
  },
  useRef(initial) { const i = cursor++; if (slots[i] === undefined) slots[i] = { current: initial }; return slots[i] },
  // Effects run after the render that asked for them, and only when their dependencies
  // changed, as the real one does.
  useEffect(fn, deps) {
    const i = effectCursor++
    const slot = effectSlots[i]
    if (slot === undefined || deps === undefined || deps.some((dep, at) => !Object.is(dep, slot[at]))) {
      effectSlots[i] = deps
      pending.push(fn)
    }
  },
  useMemo: make => make(), useLayoutEffect() {}, useSyncExternalStore: (subscribe, get) => get(), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  document: { body: {} },
  navigator: {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { OwnSignInDialog } = module.exports

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
const WAITING = { status: 'signed-out', attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/authorize', expiresAt: Date.now() + 5 * 60_000 } }

// A render also runs the components an element stands for, at any depth, as React would.
const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(child => expand(child))
  if (node && typeof node === 'object' && typeof node.type === 'function') return expand(node.type(node.props))
  if (node && typeof node === 'object' && Array.isArray(node.props?.children)) return { ...node, props: { ...node.props, children: node.props.children.flatMap(expand) } }
  return node
}

// `answer` is what the host's account-start returns; `state` what a later poll reads.
function dialog({ answer = WAITING, state = null, withOwn = true } = {}) {
  const calls = []
  slots.length = 0
  effectSlots.length = 0
  const ui = { signIn: 1 }
  const actions = withOwn ? {
    ownSignIn: () => { calls.push('open') },
    closeSignIn: () => { calls.push('close') },
    accountStart: async body => { calls.push(['start', body]); return answer },
    accountCancel: async id => { calls.push(['cancel', id]) },
    accountState: async () => { calls.push(['state']); return { available: true, state: state ?? answer } },
  } : { closeSignIn: () => { calls.push('close') } }
  // Effect cleanups run when the test ends, so their timers and intervals do not hold
  // the process.
  let disposers = []
  const render = () => {
    cursor = 0
    effectCursor = 0
    pending = []
    const tree = expand(OwnSignInDialog({ open: ui.signIn, actions }))
    for (const fn of pending.splice(0)) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    return tree
  }
  const stop = () => { for (const dispose of disposers.splice(0)) dispose() }
  return { render, stop, calls, ui }
}

test('without the own sign-in, or with no dialog open, nothing renders', (t) => {
  const side = dialog({ withOwn: false })
  t.after(side.stop)
  assert.equal(side.render(), null)
  const plain = dialog()
  plain.ui.signIn = null
  assert.equal(plain.render(), null)
})

test('an open dialog starts the sign-in on the host and offers the authorize page', async (t) => {
  const side = dialog()
  t.after(side.stop)
  side.render()
  await tick()
  side.render()
  const [what, body] = side.calls.find(([name]) => name === 'start')
  assert.equal(what, 'start')
  assert.equal(typeof body.locale, 'string')
  assert.equal(Number.isInteger(body.timezoneOffsetSeconds), true)
  const link = walk(side.render(), node => node.type === 'a')[0]
  assert.deepEqual([link.props.href, link.props.target, link.props.rel], ['https://platform.example/authorize', '_blank', 'noopener noreferrer'])
  assert.equal(textOf(link), 'Open sign-in page')
  // The link's life is named beside it, and it can be copied.
  assert.match(textOf(walk(side.render(), node => node.props.className === 'bt-account-hint')[0]), /minutes/)
  assert.ok(walk(side.render(), node => node.type === 'button' && textOf(node) === 'Copy link').length > 0)
})

test('cancel forwards the attempt id and closes the dialog', async (t) => {
  const side = dialog()
  t.after(side.stop)
  side.render()
  await tick()
  const tree = side.render()
  walk(tree, node => node.type === 'button' && textOf(node) === 'Cancel')[0].props.onClick()
  await tick()
  assert.deepEqual(side.calls.filter(name => Array.isArray(name) && name[0] === 'cancel'), [['cancel', 'a1']])
  assert.ok(side.calls.includes('close'))
})

test('a failed attempt offers to try again, which starts a new one', async (t) => {
  const side = dialog({ answer: { status: 'signed-out', attempt: { id: 'a9', phase: 'failed', errorCode: 'network' } } })
  t.after(side.stop)
  side.render()
  await tick()
  const tree = side.render()
  assert.match(textOf(walk(tree, node => node.props.className === 'bt-account-line')[0]), /failed/)
  walk(tree, node => node.type === 'button' && textOf(node) === 'Try again')[0].props.onClick()
  await tick()
  side.render()
  assert.equal(side.calls.filter(name => Array.isArray(name) && name[0] === 'start').length, 2)
})

test('a finished sign-in closes the dialog on its own', async (t) => {
  const side = dialog({ answer: { status: 'credential-stored', attempt: { id: 'a2', phase: 'succeeded' } } })
  t.after(side.stop)
  side.render()
  await tick()
  side.render()
  await tick(800)
  assert.ok(side.calls.includes('close'))
})

// The host's guard: a stored login is answered with its own state, no attempt in it.
test('a host that answers with a stored login closes the dialog on its own', async (t) => {
  const side = dialog({ answer: { status: 'credential-stored', attempt: null } })
  t.after(side.stop)
  side.render()
  await tick()
  side.render()
  await tick(800)
  assert.ok(side.calls.includes('close'))
  assert.equal(side.calls.some(name => Array.isArray(name) && name[0] === 'cancel'), false)
})

test('the poll follows the attempt while the browser has it open', async (t) => {
  const side = dialog({ answer: { status: 'signed-out', attempt: { id: 'a3', phase: 'exchanging' } } })
  t.after(side.stop)
  side.render()
  await tick()
  side.render()
  // The interval reads the host's state; its answer moves the line.
  await tick(2300)
  side.render()
  assert.ok(side.calls.some(name => Array.isArray(name) && name[0] === 'state'))
})

// The browser-side finish reaches the dialog through the poll, not the start answer.
test('the poll reading a finished sign-in closes the dialog on its own', async (t) => {
  const side = dialog({ answer: WAITING, state: { status: 'credential-stored', attempt: { id: 'a1', phase: 'succeeded' } } })
  t.after(side.stop)
  side.render()
  await tick()
  side.render()
  await tick(2300)
  side.render()
  assert.ok(side.calls.some(name => Array.isArray(name) && name[0] === 'state'))
  await tick(800)
  assert.ok(side.calls.includes('close'))
})

// A stray click outside dismisses the dialog but never cancels the attempt: it keeps
// running on the host, and a reopened sign-in joins it.
test('the scrim only dismisses; the attempt stays with the host', (t) => {
  const side = dialog()
  t.after(side.stop)
  const tree = side.render()
  walk(tree, node => node.props?.className === 'bt-scrim')[0].props.onMouseDown()
  assert.ok(side.calls.includes('close'))
  assert.equal(side.calls.some(name => Array.isArray(name) && name[0] === 'cancel'), false)
})


// The Models page's account entry, bundled the same way: the row shows where the
// window has no shell sign-in of its own and no login is stored.
const pageBundle = await build({
  stdin: {
    contents: "export { ProvidersPage } from './src/client/providers-page.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const pageModule = { exports: {} }
runInNewContext(pageBundle.outputFiles[0].text, {
  module: pageModule, exports: pageModule.exports,
  window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  document: { body: {} },
  navigator: {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { ProvidersPage } = pageModule.exports

function modelsPage({ account, shell = false } = {}) {
  slots.length = 0
  effectSlots.length = 0
  const opened = []
  const signedOutCalls = []
  // What the host answers now, and the roster's modelsKey the page follows; a sign-in
  // changes both.
  const now = { account, modelsKey: null }
  let fetched = 0
  const actions = {
    canSignIn: () => shell,
    ownSignIn: () => { opened.push('open') },
    accountSignOut: async () => {
      signedOutCalls.push(1)
      // What the host answers after removing the login, and the models it serves then.
      now.account = { available: true, status: 'signed-out' }
      now.modelsKey = null
      return { status: 'signed-out', links: {}, attempt: null }
    },
    providers: async () => {
      fetched += 1
      return { available: true, providers: [], addable: [], protocols: [], ...(now.account === undefined ? {} : { account: now.account }) }
    },
  }
  const Section = ({ title, children }) => ({ type: 'section', props: { title, children } })
  const run = promise => promise.then(() => true, failure => { throw failure })
  const roster = { modelsKey: null }
  const page = () => {
    cursor = 0
    effectCursor = 0
    pending = []
    const tree = expand(ProvidersPage({ actions, run, Section, roster: { ...roster, modelsKey: now.modelsKey } }))
    for (const fn of pending.splice(0)) fn()
    return tree
  }
  // The account news a finished sign-in brings: the served models change with it.
  const signedIn = () => { now.account = { available: true, status: 'credential-stored' }; now.modelsKey = 'deepseek/chat' }
  return { page, opened, signedIn, signedOutCalls, fetched: () => fetched }
}

test("the Models page offers the account's sign-in where the window has no shell entry", async () => {
  const side = modelsPage({ account: { available: true, status: 'signed-out' } })
  side.page()
  await tick()
  const tree = side.page()
  const row = walk(tree, node => node.props?.className?.includes('bt-account-page'))[0]
  assert.ok(row !== undefined, 'the account row is there')
  walk(row, node => node.type === 'button' && textOf(node) === 'Sign in')[0].props.onClick()
  assert.deepEqual(side.opened, ['open'])
})

test('a shell entry of its own, or no account service, leaves the row out', async () => {
  for (const options of [{ account: { available: true, status: 'signed-out' }, shell: true }, { account: { available: false } }, {}]) {
    const side = modelsPage(options)
    side.page()
    await tick()
    const tree = side.page()
    assert.equal(walk(tree, node => node.props?.className?.includes('bt-account-page')).length, 0)
  }
})

test('a stored login shows itself and offers the sign-out in its place', async () => {
  const side = modelsPage({ account: { available: true, status: 'credential-stored' } })
  side.page()
  await tick()
  const tree = side.page()
  const row = walk(tree, node => node.props?.className?.includes('bt-account-page'))[0]
  assert.ok(row !== undefined, 'the account row is there')
  assert.match(textOf(row), /Signed in\./)
  assert.ok(walk(row, node => node.type === 'button' && textOf(node) === 'Sign out').length > 0)
  assert.equal(walk(row, node => node.type === 'button' && textOf(node) === 'Sign in').length, 0)
})

test('a sign-in while the page is open refetches, and the row turns to the stored login', async () => {
  const side = modelsPage({ account: { available: true, status: 'signed-out' } })
  side.page()
  await tick()
  const before = side.page()
  assert.ok(walk(before, node => node.props?.className?.includes('bt-account-page')).length > 0, 'the row is there')
  side.signedIn()
  await tick()
  side.page()
  await tick()
  const tree = side.page()
  // The modelsKey changed, so the page asked the host again; the row now carries the
  // stored login and its sign-out instead of another sign-in.
  assert.equal(side.fetched(), 2)
  const row = walk(tree, node => node.props?.className?.includes('bt-account-page'))[0]
  assert.ok(walk(row, node => node.type === 'button' && textOf(node) === 'Sign out').length > 0)
  assert.equal(walk(row, node => node.type === 'button' && textOf(node) === 'Sign in').length, 0)
})

test('the sign-out asks once, then signs out on the host and the row turns back', async () => {
  const side = modelsPage({ account: { available: true, status: 'credential-stored' } })
  side.page()
  await tick()
  let tree = side.page()
  const row = () => walk(tree, node => node.props?.className?.includes('bt-account-page'))[0]
  walk(row(), node => node.type === 'button' && textOf(node) === 'Sign out')[0].props.onClick()
  tree = side.page()
  // The question stands in the row first, and keeping changes nothing.
  assert.match(textOf(row()), /Bots on its models/)
  walk(row(), node => node.type === 'button' && textOf(node) === 'Keep')[0].props.onClick()
  tree = side.page()
  assert.equal(side.signedOutCalls.length, 0)
  // Signing out asks the host, then follows its answer with a fresh providers view.
  walk(row(), node => node.type === 'button' && textOf(node) === 'Sign out')[0].props.onClick()
  tree = side.page()
  walk(row(), node => node.type === 'button' && textOf(node) === 'Sign out')[0].props.onClick()
  await tick()
  tree = side.page()
  assert.equal(side.signedOutCalls.length, 1)
  assert.ok(walk(row(), node => node.type === 'button' && textOf(node) === 'Sign in').length > 0)
  assert.equal(walk(row(), node => node.type === 'button' && textOf(node) === 'Sign out').length, 0)
})

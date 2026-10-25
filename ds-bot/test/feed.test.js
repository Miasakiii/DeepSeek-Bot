import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 3,
  bots: {
    m1: { id: 'm1', sessionId: 'm1c', segments: [{ sessionId: 'm1', endedAt: 50 }], name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  // Chief's turn 7 answers another Bot, so the chat does not show it.
  exchangeTurns: { m1c: [7] },
  questions: {},
}

const userMessage = (text, time) => ({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const botMessage = (text, time, turn = 1) => ({ type: 'assistant/message', time, data: { turn, message: { content: [{ type: 'text', text }] } } })

function start({ pages = {}, services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-feed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 100 } } }),
    // Two pages per Session, newest first, keyed by the cursor that asks for them.
    page: async ({ address, beforeSeq }) => pages[`${address.sessionId}:${beforeSeq ?? 'end'}`] ?? { records: [], hasMore: false },
  }
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

// Reads Server-Sent Events off a response, one `{ event, data }` per call.
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

test('the live feed tells a window about saves, new chat entries and the reply being written', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const next = reader(response)
  assert.equal((await next()).event, 'hello')

  await call('set-prefs', { motion: 'lively' })
  const saved = await next()
  assert.equal(saved.event, 'revision')
  assert.equal(saved.data.revision > TEAM.revision, true)

  // The feed's own listener is the last on session/event; the others need a live dsh.
  const onEvent = ctx.listeners.get('session/event').at(-1)
  onEvent({ id: 'm1c' }, userMessage('hello', 60))
  assert.deepEqual(await next(), { event: 'message', data: { botId: 'm1', sessionId: 'm1c', item: { kind: 'user', text: 'hello', time: 60 } } })
  // A group Session or an earlier part is not a Bot's own chat now.
  onEvent({ id: 'm1' }, userMessage('old', 1))
  onEvent({ id: 'm1c' }, botMessage('hidden', 61, 7))

  const [onStream] = ctx.listeners.get('agent/assistant-stream')
  const agent = { id: 'm1c' }
  onStream({ agent, frame: { type: 'start', attemptId: 'a7', turn: 7 } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a7', chunk: { type: 'text-delta', text: 'hidden' } } })
  onStream({ agent, frame: { type: 'start', attemptId: 'a1', turn: 8 } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: 'hmm' } } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'Hi ' } } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'there' } } })
  onStream({ agent, frame: { type: 'end', attemptId: 'a1' } })
  onStream({ agent, frame: { type: 'end', attemptId: 'a7' } })
  const target = { botId: 'm1', sessionId: 'm1c', attemptId: 'a1' }
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'start' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: 'Hi ' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: 'there' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'end' } })

  // Status changes in a burst come as one notice.
  const onStatus = ctx.listeners.get('agent/status').at(-1)
  for (const id of ['b2', 'm1c', 'b2']) onStatus({ agent: { id }, status: 'running' })
  onStatus({ agent: { id: 'not-a-bot' }, status: 'running' })
  assert.deepEqual(await next(), { event: 'live', data: {} })

  abort.abort()
  assert.equal(await next(), undefined)
})

test('a window that stops reading the feed is dropped', { timeout: 10_000 }, async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const response = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed'))
  const onEvent = ctx.listeners.get('session/event').at(-1)
  for (let index = 0; index < 1000; index += 1) onEvent({ id: 'm1c' }, userMessage(`line ${index}`, index))
  // What was queued before the drop still arrives, then the stream ends.
  const next = reader(response)
  let count = 0
  while (await next() !== undefined) count += 1
  assert.equal(count > 1 && count < 1000, true)
})

test('the chat endpoint pages a Bot\'s own chat from the newest part back', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const { call, stop } = start({
    pages: {
      'm1c:end': { records: [record(userMessage('second', 70), 41), record(botMessage('reply', 71), 42)], hasMore: true },
      'm1c:41': { records: [record(userMessage('first', 60), 40)], hasMore: false },
      'm1:end': { records: [record(userMessage('long ago', 5), 3)], hasMore: false },
    },
  })
  t.after(stop)
  await call('state')
  const first = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(first, {
    sessionId: 'm1c',
    items: [{ kind: 'user', text: 'second', time: 70 }, { kind: 'bot', text: 'reply', time: 71 }],
    cursor: { part: 1, beforeSeq: 41 },
  })
  // The current part's first message has the line that marks where the part began.
  const second = (await call('chat', { botId: 'm1', cursor: first.cursor })).value
  assert.deepEqual(second.items, [{ kind: 'divider', time: 50 }, { kind: 'user', text: 'first', time: 60 }])
  assert.deepEqual(second.cursor, { part: 0 })
  const third = (await call('chat', { botId: 'm1', cursor: second.cursor })).value
  assert.deepEqual([third.items, third.cursor], [[{ kind: 'user', text: 'long ago', time: 5 }], null])
  assert.equal((await call('chat', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('earlier items list a display-only view card at its call, and only that one', async (t) => {
  // The call block in an assistant message, as dsh-llm's BlockAssembler writes it.
  const viewCall = (id, args, turn = 8) => ({ type: 'assistant/message', time: 70, data: { turn, message: { content: [{ type: 'tool-call', id, name: 'show_view', arguments: JSON.stringify(args) }] } } })
  const metric = { type: 'stack', children: [{ type: 'metric', label: 'Steps', value: 3 }] }
  const record = (event, seq) => ({ event: { ...event, seq } })
  const { call, stop } = start({
    pages: {
      'm1c:end': {
        records: [
          // A hidden exchange turn shows none of its calls, its view cards too.
          record(viewCall('v4', { title: 'Hidden', view: metric }, 7), 40),
          record({ type: 'assistant/message', time: 70, data: { turn: 8, message: { content: [{ type: 'text', text: 'here you go' }, { type: 'tool-call', id: 'v1', name: 'show_view', arguments: JSON.stringify({ title: '  Status  ', view: metric }) }] } } }, 41),
          // An interactive card waits for its answer, which lists as its own entry.
          record(viewCall('v2', { title: 'Pick', view: { type: 'options', id: 'o', options: [{ label: 'A' }] } }, 9), 42),
          // A display-only card cannot wait for a reply; the host refuses the call.
          record(viewCall('v5', { title: 'Status', view: metric, await_reply: true }, 10), 43),
        ],
        hasMore: false,
      },
      'm1:end': {
        // A blueprint the host refused drew no card, so it gives no entry.
        records: [record(viewCall('v3', { title: 'Broken', view: { type: 'nope' } }, 3), 3)],
        hasMore: false,
      },
    },
  })
  t.after(stop)
  await call('state')
  const first = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(first.items, [
    // The current part has no earlier page of its own, so it opens with its line.
    { kind: 'divider', time: 50 },
    { kind: 'bot', text: 'here you go', time: 70 },
    { kind: 'view', title: 'Status', view: metric, time: 70 },
  ])
  const second = (await call('chat', { botId: 'm1', cursor: first.cursor })).value
  assert.deepEqual(second.items, [])
})

test('the run-stats endpoint reads DSH\'s figures for the current part of a Bot\'s chat', async (t) => {
  const views = { sessionStats: { turns: 3 }, tokenUsage: { cacheReadTokens: 9 }, contextPressure: { contextWindow: 100 } }
  const read = []
  const sessionProjections = {
    snapshot: (session, keys) => {
      read.push([session.id, keys])
      return { asOfSeq: 7, values: views }
    },
  }
  const { call, stop } = start({ services: { sessionProjections } })
  t.after(stop)
  await call('state')
  assert.deepEqual((await call('run-stats', { botId: 'm1' })).value, views)
  assert.deepEqual(read, [['m1c', ['sessionStats', 'tokenUsage', 'contextPressure']]])
  assert.equal((await call('run-stats', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('without DSH\'s session projections the run-stats endpoint has nothing to show', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  await call('state')
  assert.deepEqual(await call('run-stats', { botId: 'm1' }), { ok: true, value: null })
})

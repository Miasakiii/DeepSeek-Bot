import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { BlockAssembler } from '../src/host/vendor/messages.js'
import { PROTOCOLS } from '../src/host/providers.js'
import { serializeRequest, streamWire } from '../src/host/llm.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const noImages = async () => { throw new Error('no image expected') }

const readLines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(entry => JSON.parse(entry)) : [])

// The mock model on a free port, with its log in a throwaway folder. It answers the
// same scripted scenarios on the Anthropic wire and the two OpenAI-side ones.
const startMock = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mock-'))
  const log = join(home, 'mock.jsonl')
  const child = spawn(process.execPath, [join(ROOT, 'dev', 'mock-llm.mjs'), home], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: log, MOCK_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the mock did not start')), 20000)
    child.stdout.on('data', part => {
      const text = String(part)
      if (!text.includes('mock on http')) return
      clearTimeout(timer)
      resolve(text)
    })
    child.on('error', reject)
  })
  return { child, home, baseURL: /http:\/\/127\.0\.0\.1:\d+\/v1/.exec(line)[0], log: () => readLines(log) }
}

// The logging pass-through in front of the mock, on a free port of its own.
const startTap = async (upstream) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tap-'))
  const log = join(home, 'tap.jsonl')
  const child = spawn(process.execPath, [join(ROOT, 'dev', 'llm-tap.mjs'), '0', upstream, log], { stdio: ['ignore', 'pipe', 'pipe'] })
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the tap did not start')), 20000)
    child.stdout.on('data', part => {
      const text = String(part)
      if (!text.includes('llm-tap:')) return
      clearTimeout(timer)
      resolve(text)
    })
    child.on('error', reject)
  })
  return { child, home, baseURL: `http://127.0.0.1:${/127\.0\.0\.1:(\d+)/.exec(line)[1]}`, log: () => readLines(log) }
}

describe('the mock and the tap on the three wires', () => {
  let mock, tap

  before(async () => {
    mock = await startMock()
    tap = await startTap(mock.baseURL)
  })

  after(() => {
    for (const child of [mock.child, tap.child]) child.kill()
    for (const home of [mock.home, tap.home]) rmSync(home, { recursive: true, force: true })
  })

  // One scripted answer through the plugin's own client: the request is serialized for
  // the wire, the mock answers it, and the chunks are assembled the way a consumer
  // assembles them.
  async function ask(protocol, text, tools, baseURL = mock.baseURL) {
    const body = await serializeRequest(protocol, {
      model: 'mock-model',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      ...(tools === undefined ? {} : { tools }),
    }, noImages)
    const assembler = new BlockAssembler()
    for await (const chunk of streamWire({ protocol, baseURL, apiKey: 'sk-mock', body })) assembler.push(chunk)
    return { blocks: assembler.blocks(), finish: assembler.finish }
  }

  // The tap writes its line as the response ends, so a reader may need a moment.
  const settled = async (read, wanted) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const lines = read()
      if (lines.length >= wanted) return lines
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return read()
  }

  test('the mock answers a plain message on all three wires', async () => {
    for (const protocol of PROTOCOLS) {
      const { blocks, finish } = await ask(protocol, 'hello')
      assert.equal(finish.kind, 'stop', protocol)
      // Chat completions carries no block boundaries, so its two scripted lines arrive
      // as one text block; the other two wires keep them apart.
      const wanted = protocol === 'openai-completions'
        ? [['text', '收到：hello还有别的要我盯的吗？']]
        : [['text', '收到：hello'], ['text', '还有别的要我盯的吗？']]
      assert.deepEqual(blocks.map(block => [block.type, block.text]), wanted, protocol)
    }
  })

  test('the mock answers a tool scenario on all three wires', async () => {
    for (const protocol of PROTOCOLS) {
      const { blocks, finish } = await ask(protocol, '视图选项', [{ name: 'show_view', description: 'Draw a card', parameters: { type: 'object' } }])
      assert.equal(finish.kind, 'tool-calls', protocol)
      assert.deepEqual(blocks.map(block => [block.type, block.name]), [['tool-call', 'show_view']], protocol)
      assert.deepEqual(JSON.parse(blocks[0].arguments), { title: 'Pick a lane', view: { type: 'options', id: 'lane', options: [{ label: 'Ship now' }, { label: 'One more pass' }] } }, protocol)
    }
  })

  test('the mock reports usage before the finish on all three wires', async () => {
    for (const protocol of PROTOCOLS) {
      const body = await serializeRequest(protocol, { model: 'mock-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, noImages)
      const chunks = []
      for await (const chunk of streamWire({ protocol, baseURL: mock.baseURL, apiKey: 'sk-mock', body })) chunks.push(chunk)
      const usage = chunks.find(chunk => chunk.type === 'usage')
      assert.equal(chunks.at(-1).type, 'finish', protocol)
      assert.ok(usage !== undefined && usage.usage.inputTokens > 0 && usage.usage.outputTokens > 0, protocol)
      // The cached part is folded into the prompt total and split back out.
      assert.ok((usage.usage.cacheReadTokens ?? 0) > 0, protocol)
    }
  })

  test('the mock fails a refused key and an overflow on all three wires', async () => {
    for (const protocol of PROTOCOLS) {
      await assert.rejects(ask(protocol, '报错'), error => error.kind === 'auth' && error.retryable === false, protocol)
      await assert.rejects(ask(protocol, '撑爆'), error => error.kind === 'request' && error.retryable === false, protocol)
    }
  })

  test('the mock logs one shape whatever wire the request came on', async () => {
    const before = mock.log().length
    for (const protocol of PROTOCOLS) await ask(protocol, 'hello')
    const entries = mock.log().slice(before)
    assert.equal(entries.length, 3)
    for (const entry of entries) {
      // The scenario engine read the same conversation on every wire: the same last
      // user line, the same answer, the same message count. Token counts follow each
      // wire's own encoding of the request, so only their presence is asserted.
      assert.equal(entry.last, 'hello')
      assert.equal(entry.out[0].text, '收到：hello')
      assert.equal(entry.messages, entries[0].messages)
      assert.ok(Number.isInteger(entry.tokens) && entry.tokens > 0)
    }
  })

  test('the tap describes a call on every wire in one shape', async () => {
    for (const protocol of PROTOCOLS) {
      const before = tap.log().length
      const { blocks } = await ask(protocol, 'hello', undefined, tap.baseURL)
      const lines = (await settled(() => tap.log(), before + 1)).slice(before)
      assert.equal(lines.length, 1, protocol)
      const call = lines[0]
      assert.equal(call.status, 200, protocol)
      assert.equal(call.kind, 'main', protocol)
      assert.equal(call.lastUser, 'hello', protocol)
      assert.equal(call.messages, 1, protocol)
      assert.equal(call.text, '收到：hello还有别的要我盯的吗？', protocol)
      assert.ok(call.tokens.prompt > 0 && call.tokens.cached > 0 && call.tokens.output > 0, protocol)
      // The answer arrived whole, and the two scripted lines stayed in one text block
      // only where the wire cannot separate them.
      assert.equal(blocks.length, protocol === 'openai-completions' ? 1 : 2, protocol)
    }
  })
})

// The two places where the vendor BlockAssembler and DSH's disagree (plan 2026-10-30
// §1.2 gap 4, decision N-02), locked as the vendor's current semantics — known
// divergences, not changes to them. ds-bot's own producers never trigger either shape:
// llm.js's block tracker always opens a block before its deltas and closes a phase
// before the next one starts, and parts.js and groups.js pair their starts and ends
// explicitly. The nine ctx.llm.stream call sites, though, consume the chunks DSH's own
// producers emit, so a producer that misbehaves this way reaches the vendor assembler.
test('a block type change on an open index opens a new block and drops what it held', () => {
  // DSH's ensure() keeps the open partial whatever type the next delta names and
  // appends the delta to it, so its assembler would report one text block reading
  // "first second". The vendor opens a fresh block at the index instead.
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: 'first ' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'second' })
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: 'second' }])
})

test('a delta after block-end on the same index overwrites the closed block', () => {
  // DSH ignores a delta for an index its block-end already closed, so its assembler
  // would report the finished block, "done". The vendor replaces the closed entry, and
  // the late delta's block takes its place.
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: 'done' })
  assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'done' } })
  assembler.push({ type: 'text-delta', index: 0, text: 'late' })
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'late' }])
})

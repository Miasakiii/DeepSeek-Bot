import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { keyVault, providerEntry, streamWire, wireFailure, wireRequest } from '../src/host/llm.js'

// A scripted provider: answers every request with the given server-sent events.
function serve(events, { status = 200 } = {}) {
  const body = events.map(line => `data: ${line}`).join('\n\n') + '\n\n'
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'text/event-stream' })
    res.end(body)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseURL: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done)),
    }))
  })
}

const collect = async stream => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('openai-completions turns reasoning, text and tool phases into blocks', async () => {
  const provider = await serve([
    '{"choices":[{"delta":{"reasoning_content":"thinking "}}]}',
    '{"choices":[{"delta":{"reasoning_content":"hard"}}]}',
    '{"choices":[{"delta":{"content":"Hello"}}]}',
    '{"choices":[{"delta":{"content":" world"}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"SF\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128,"prompt_tokens_details":{"cached_tokens":100}}}',
    '[DONE]',
  ])
  try {
    const chunks = await collect(streamWire({ protocol: 'openai-completions', baseURL: provider.baseURL, apiKey: 'sk-test', body: {} }))
    const kinds = chunks.map(chunk => chunk.type)
    assert.deepEqual(kinds, [
      'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
      'block-start', 'text-delta', 'text-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    assert.deepEqual(chunks[3].block, { type: 'reasoning', text: 'thinking hard' })
    assert.deepEqual(chunks[7].block, { type: 'text', text: 'Hello world' })
    assert.deepEqual(chunks[10].block, { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' })
    // prompt_tokens folds the cached part in, so it is split back out.
    assert.deepEqual(chunks[11].usage, { inputTokens: 20, outputTokens: 8, totalTokens: 128, cacheReadTokens: 100 })
    assert.deepEqual(chunks[12].reason, { kind: 'tool-calls' })
  } finally { await provider.close() }
})

test('openai-completions reports the token ceiling as max-tokens', async () => {
  const provider = await serve([
    '{"choices":[{"delta":{"content":"partial"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"length"}]}',
    '[DONE]',
  ])
  try {
    const chunks = await collect(streamWire({ protocol: 'openai-completions', baseURL: provider.baseURL, apiKey: 'sk-test', body: {} }))
    assert.deepEqual(chunks.at(-2).block, { type: 'text', text: 'partial' })
    assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
  } finally { await provider.close() }
})

test('openai-responses narrates output items and separates cached input', async () => {
  const provider = await serve([
    '{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"r1"}}',
    '{"type":"response.reasoning_text.delta","delta":"ponder"}',
    '{"type":"response.output_item.added","output_index":1,"item":{"type":"message"}}',
    '{"type":"response.output_text.delta","delta":"Hi"}',
    '{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"call_9","name":"search"}}',
    '{"type":"response.function_call_arguments.delta","delta":"{}"}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55,"input_tokens_details":{"cached_tokens":10}}}}',
  ])
  try {
    const chunks = await collect(streamWire({ protocol: 'openai-responses', baseURL: provider.baseURL, apiKey: 'sk-test', body: {} }))
    assert.deepEqual(chunks.map(chunk => chunk.type), [
      'block-start', 'reasoning-delta', 'block-end',
      'block-start', 'text-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    assert.deepEqual(chunks.at(-2).usage, { inputTokens: 40, outputTokens: 5, totalTokens: 55, cacheReadTokens: 10 })
    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
    assert.deepEqual(chunks[7], { type: 'tool-call-delta', index: 2, id: 'call_9', argumentsDelta: '{}' })
  } finally { await provider.close() }
})

test('anthropic-messages maps thinking, tool_use and cache fields', async () => {
  const provider = await serve([
    '{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}',
    '{"type":"ping"}',
    '{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}',
    '{"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
    '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}',
    '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"calc"}}',
    '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"[1"}}',
    '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"]"}}',
    '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}',
    '{"type":"message_stop"}',
  ])
  try {
    const chunks = await collect(streamWire({ protocol: 'anthropic-messages', baseURL: provider.baseURL, apiKey: 'sk-test', body: {} }))
    assert.deepEqual(chunks.map(chunk => chunk.type), [
      'block-start', 'reasoning-delta',
      'block-start', 'text-delta',
      'block-start', 'tool-call-delta', 'tool-call-delta',
      'block-end', 'block-end', 'block-end',
      'usage', 'finish',
    ])
    assert.deepEqual(chunks[8].block, { type: 'text', text: 'Hi' })
    assert.deepEqual(chunks[9].block, { type: 'tool-call', id: 'toolu_1', name: 'calc', arguments: '[1]' })
    // Anthropic's input_tokens already excludes cache reads and writes.
    assert.deepEqual(chunks[10].usage, { inputTokens: 10, outputTokens: 42, cacheReadTokens: 7, cacheWriteTokens: 3 })
    assert.deepEqual(chunks[11].reason, { kind: 'tool-calls' })
  } finally { await provider.close() }
})

test('a refused key and a throttled key fail in distinct, honest ways', async () => {
  const auth = await serve([], { status: 401 })
  const throttle = await serve([], { status: 429 })
  try {
    await assert.rejects(
      collect(streamWire({ protocol: 'openai-completions', baseURL: auth.baseURL, apiKey: 'bad', body: {} })),
      error => error.kind === 'auth' && error.retryable === false && error.status === 401,
    )
    await assert.rejects(
      collect(streamWire({ protocol: 'openai-completions', baseURL: throttle.baseURL, apiKey: 'good', body: {} })),
      error => error.kind === 'rate-limit' && error.retryable === true,
    )
  } finally { await auth.close(); await throttle.close() }
})

test('a provider that never answers fails as a timeout when the signal fires', async () => {
  const server = createServer(() => {})
  const stopped = new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await stopped
  const baseURL = `http://127.0.0.1:${server.address().port}`
  try {
    await assert.rejects(
      collect(streamWire({ protocol: 'openai-completions', baseURL, apiKey: 'k', body: {}, signal: AbortSignal.timeout(100) })),
      error => error.kind === 'timeout' && error.retryable === true,
    )
  } finally { server.close() }
})

test('a dead port fails as a network failure', async () => {
  const probe = createServer()
  const stopped = new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  await stopped
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  await assert.rejects(
    collect(streamWire({ protocol: 'openai-completions', baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', body: {} })),
    error => error.kind === 'network' && error.retryable === true,
  )
})

test('wireRequest carries each protocol\'s auth and the attribution headers', () => {
  const attribution = { 'x-app': 'miasaki-dsbot' }
  const openai = wireRequest({ protocol: 'openai-completions', baseURL: 'https://api.example.com/v1/', apiKey: 'sk-1', attribution })
  assert.equal(openai.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(openai.headers.authorization, 'Bearer sk-1')
  assert.equal(openai.headers['x-app'], 'miasaki-dsbot')
  assert.equal(wireRequest({ protocol: 'openai-responses', baseURL: 'https://api.example.com/v1', apiKey: 'sk-1' }).url, 'https://api.example.com/v1/responses')
  const anthropic = wireRequest({ protocol: 'anthropic-messages', baseURL: 'https://api.example.com', apiKey: 'ak-1', attribution })
  assert.equal(anthropic.url, 'https://api.example.com/v1/messages')
  assert.equal(anthropic.headers['x-api-key'], 'ak-1')
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01')
  assert.equal(anthropic.headers['x-app'], 'miasaki-dsbot')
  assert.throws(() => wireRequest({ protocol: 'carrier-pigeon', baseURL: 'https://api.example.com', apiKey: 'k' }), /protocol/)
  assert.throws(() => wireRequest({ protocol: 'openai-completions', baseURL: 'ftp://api.example.com', apiKey: 'k' }), /http or https/)
})

test('providerEntry normalizes a route and refuses the unusable ones', () => {
  const entry = providerEntry({
    id: 'my-vllm',
    name: 'My vLLM',
    protocol: 'openai-completions',
    baseURL: 'http://127.0.0.1:8000/v1',
    models: [{ id: 'llama-4', name: 'Llama 4', contextWindow: 128000 }, 'qwen-3'],
  })
  assert.equal(entry.keyRef, 'MY_VLLM_API_KEY')
  assert.equal(entry.baseURL, 'http://127.0.0.1:8000/v1')
  assert.deepEqual(entry.models, [{ id: 'llama-4', name: 'Llama 4', contextWindow: 128000 }, { id: 'qwen-3' }])
  assert.throws(() => providerEntry({ id: 'Bad_ID', protocol: 'openai-completions', baseURL: 'https://x', models: ['m'] }), /id/)
  assert.throws(() => providerEntry({ id: 'ok', protocol: 'grpc', baseURL: 'https://x', models: ['m'] }), /protocol/)
  assert.throws(() => providerEntry({ id: 'ok', protocol: 'openai-completions', baseURL: 'https://x', models: [] }), /at least one model/)
})

test('the key vault seals keys at rest and survives reopening', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-keys-'))
  try {
    const vault = keyVault(home)
    await vault.set('MY_VLLM_API_KEY', 'sk-secret-value')
    assert.equal(await vault.get('MY_VLLM_API_KEY'), 'sk-secret-value')
    assert.deepEqual(await vault.refs(), ['MY_VLLM_API_KEY'])
    // What lies in the file must not be the key, and the master key must exist.
    const stored = readFileSync(join(home, 'keys.json'), 'utf8')
    assert.ok(!stored.includes('sk-secret-value'))
    assert.ok(readFileSync(join(home, '.keys-master'), 'utf8').trim() !== '')
    // A second instance over the same home reads the same key.
    assert.equal(await keyVault(home).get('MY_VLLM_API_KEY'), 'sk-secret-value')
    assert.equal(await vault.remove('MY_VLLM_API_KEY'), true)
    assert.equal(await vault.get('MY_VLLM_API_KEY'), undefined)
    assert.equal(await vault.remove('MY_VLLM_API_KEY'), false)
    // A tampered entry must not decrypt; a fresh instance re-reads the file.
    await vault.set('A_KEY', 'v1')
    const raw = JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8'))
    raw.entries.A_KEY.value = raw.entries.A_KEY.value.slice(0, -4) + 'AAAA'
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(home, 'keys.json'), JSON.stringify(raw))
    await assert.rejects(() => keyVault(home).get('A_KEY'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('streamWire refuses an unknown protocol without a request', async () => {
  await assert.rejects(
    collect(streamWire({ protocol: 'grpc', baseURL: 'https://api.example.com', apiKey: 'k', body: {} })),
    error => error.code === 'bot/invalid',
  )
})

test('wireFailure marks only transient causes retryable', () => {
  assert.equal(wireFailure('rate-limit', 'slow down').retryable, true)
  assert.equal(wireFailure('server', 'down').retryable, true)
  assert.equal(wireFailure('network', 'unreachable').retryable, true)
  assert.equal(wireFailure('timeout', 'late').retryable, true)
  assert.equal(wireFailure('auth', 'no').retryable, false)
  assert.equal(wireFailure('request', 'bad').retryable, false)
})

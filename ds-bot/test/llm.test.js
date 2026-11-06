import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { BotLlmAdapter, discoverWireModels, install as installLlm, keyVault, providerEntry, serializeRequest, streamWire, wireFailure, wireRequest } from '../src/host/llm.js'

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

// ---- phase A: the adapter over the wire clients ----

const ENTRY = {
  id: 'own',
  name: 'Own endpoint',
  protocol: 'openai-completions',
  baseURL: 'https://api.example.com/v1',
  keyRef: 'OWN_API_KEY',
  models: [{ id: 'm1', name: 'Model One', contextWindow: 128000, maxTokens: 8192, input: ['text'] }],
}

const ASK = {
  model: 'm1',
  system: 'You are a Bot.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 'call_1', name: 'look', arguments: '{"q":1}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ],
  tools: [{ name: 'look', description: 'Look it up', parameters: { type: 'object' } }],
  temperature: 0.5,
  maxTokens: 2048,
  stop: ['END'],
}

const noImages = async () => { throw new Error('no image expected') }

test('serializeRequest maps the conversation onto openai-completions', async () => {
  const body = await serializeRequest('openai-completions', ASK, noImages)
  assert.equal(body.model, 'm1')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.temperature, 0.5)
  assert.equal(body.max_tokens, 2048)
  assert.deepEqual(body.stop, ['END'])
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'look', description: 'Look it up', parameters: { type: 'object' } } }])
  assert.equal(body.tool_choice, 'auto')
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are a Bot.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'look', arguments: '{"q":1}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    { role: 'user', content: 'thanks' },
  ])
})

test('serializeRequest maps the conversation onto openai-responses', async () => {
  const body = await serializeRequest('openai-responses', ASK, noImages)
  assert.equal(body.model, 'm1')
  assert.equal(body.stream, true)
  assert.equal(body.instructions, 'You are a Bot.')
  assert.equal(body.max_output_tokens, 2048)
  assert.deepEqual(body.tools, [{ type: 'function', name: 'look', description: 'Look it up', parameters: { type: 'object' } }])
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'call_1', name: 'look', arguments: '{"q":1}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ])
})

test('serializeRequest maps the conversation onto anthropic-messages and joins same-role messages', async () => {
  const body = await serializeRequest('anthropic-messages', ASK, noImages)
  assert.equal(body.model, 'm1')
  assert.equal(body.stream, true)
  assert.equal(body.system, 'You are a Bot.')
  assert.equal(body.max_tokens, 2048)
  assert.deepEqual(body.stop_sequences, ['END'])
  assert.deepEqual(body.tools, [{ name: 'look', description: 'Look it up', input_schema: { type: 'object' } }])
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'call_1', name: 'look', input: { q: 1 } }] },
    // The tool result is a user message, so it joins the one before it.
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }, { type: 'text', text: 'thanks' }] },
  ])
})

test('serializeRequest sends an image as each protocol\'s own part and a file as handle text', async () => {
  const image = { mediaType: 'image/png', data: 'cG5n' }
  const shot = async ref => (ref.attachmentId === 'sha256:1' ? image : undefined)
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', attachment: { attachmentId: 'sha256:1', mediaType: 'image/png', bytes: 3, width: 2, height: 2 } },
      { type: 'file', attachment: { attachmentId: 'sha256:2', name: 'notes.txt', bytes: 12 } },
    ],
  }]
  const openai = await serializeRequest('openai-completions', { model: 'm1', messages }, shot)
  assert.deepEqual(openai.messages[0].content, [
    { type: 'text', text: 'what is this\n[File "notes.txt" (12 bytes, sha256:2) was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } },
  ])
  const responses = await serializeRequest('openai-responses', { model: 'm1', messages }, shot)
  assert.deepEqual(responses.input[0].content, [
    { type: 'input_text', text: 'what is this\n[File "notes.txt" (12 bytes, sha256:2) was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]' },
    { type: 'input_image', image_url: 'data:image/png;base64,cG5n' },
  ])
  const anthropic = await serializeRequest('anthropic-messages', { model: 'm1', messages }, shot)
  assert.deepEqual(anthropic.messages[0].content, [
    { type: 'text', text: 'what is this\n[File "notes.txt" (12 bytes, sha256:2) was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
  ])
  assert.deepEqual(image, { mediaType: 'image/png', data: 'cG5n' })
})

test('serializeRequest skips empty messages and refuses an unknown protocol', async () => {
  const messages = [
    { role: 'user', content: [] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'private' }] },
    { role: 'developer', content: [{ type: 'tool-addition', toolName: 'look' }] },
    { role: 'user', content: [{ type: 'text', text: 'real' }] },
  ]
  const body = await serializeRequest('openai-completions', { model: 'm1', messages }, noImages)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'real' }])
  assert.equal(body.tools, undefined)
  assert.throws(() => serializeRequest('carrier-pigeon', { model: 'm1', messages: [] }, noImages), /protocol/)
})

// A fake llm runtime that records registrations and route swaps, and refuses a route
// another adapter already serves, as the real one does.
function fakeLlm({ served = [] } = {}) {
  const registrations = []
  return {
    registrations,
    listProviders: () => served.map(id => ({ id, name: id })),
    registerAdapter(providers, adapter) {
      const clash = providers.find(id => served.includes(id))
      if (clash !== undefined) throw Object.assign(new Error(`duplicate adapter for ${clash}`), { code: 'DUPLICATE_ADAPTER' })
      const entry = { providers, adapter, replaced: [] }
      registrations.push(entry)
      const handle = () => {}
      handle.replace = next => { entry.replaced.push(next) }
      return handle
    },
  }
}

function fakeRuntime({ ctx, home, state = { providers: {} }, identity }) {
  const warnings = []
  const rt = {
    ctx,
    home,
    state,
    warn: (...args) => warnings.push(format(...args)),
    save: async () => {},
  }
  installLlm(rt, BotLlmAdapter, identity)
  return { rt, warnings }
}

test('the adapter serves the directory it is given and refuses a route it lost', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-adapter-'))
  try {
    const vault = keyVault(home)
    const adapter = new BotLlmAdapter({ routes: () => [ENTRY], vault, attachments: () => undefined })
    assert.deepEqual(adapter.providerInfo('own'), { id: 'own', name: 'Own endpoint' })
    assert.deepEqual(await adapter.listModels('own'), [{ provider: 'own', id: 'm1', name: 'Model One', inputModalities: ['text'] }])
    const resolved = await adapter.resolveModel('own', 'm1')
    assert.deepEqual(resolved, {
      provider: 'own', id: 'm1', name: 'Model One',
      inputModalities: ['text'], context: { contextWindow: 128000 }, defaultMaxTokens: 8192,
    })
    await assert.rejects(() => adapter.resolveModel('gone', 'm1'), error => error.code === 'NO_ADAPTER')
    await assert.rejects(() => adapter.resolveModel('own', 'nope'), error => error.code === 'NO_MODEL')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a prepared call keeps its own generation when the directory changes under it', async () => {
  const first = await serve(['{"choices":[{"delta":{"content":"one"}}]}', '[DONE]'])
  const second = await serve(['{"choices":[{"delta":{"content":"two"}}]}', '[DONE]'])
  try {
    let routes = [{ ...ENTRY, baseURL: first.baseURL }]
    const vault = keyVault(mkdtempSync(join(tmpdir(), 'ds-bot-gen-')))
    const adapter = new BotLlmAdapter({ routes: () => routes, vault, attachments: () => undefined })
    await vault.set('OWN_API_KEY', 'sk-test')
    const prepared = await adapter.prepareCall('own', 'm1')
    // The directory moves the route to another endpoint between prepare and dispatch.
    routes = [{ ...ENTRY, baseURL: second.baseURL }]
    const chunks = []
    for await (const chunk of prepared.stream({ provider: 'own', model: 'm1', messages: [] })) chunks.push(chunk)
    assert.deepEqual(chunks.at(-2).block, { type: 'text', text: 'one' })
  } finally {
    await first.close()
    await second.close()
  }
})

test('a stream through the adapter sends the attribution headers and the serialized body', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, agent: req.headers['user-agent'], body: '' })
    req.on('data', part => { seen[0].body += part })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const vault = keyVault(mkdtempSync(join(tmpdir(), 'ds-bot-stream-')))
    const adapter = new BotLlmAdapter({ routes: () => [{ ...ENTRY, baseURL: `http://127.0.0.1:${server.address().port}` }], vault, attachments: () => undefined })
    await vault.set('OWN_API_KEY', 'sk-vault-key')
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'own', model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) chunks.push(chunk)
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
    assert.equal(seen[0].url, '/chat/completions')
    assert.equal(seen[0].authorization, 'Bearer sk-vault-key')
    assert.match(seen[0].agent, /deepseek/i)
    const sent = JSON.parse(seen[0].body)
    assert.equal(sent.stream, true)
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'hi' }])
  } finally {
    await new Promise(done => server.close(done))
  }
})

test('the key comes from the vault, then the environment, and its absence is an auth failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-key-'))
  const provider = await serve(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])
  const env = process.env.OWN_API_KEY
  try {
    delete process.env.OWN_API_KEY
    const vault = keyVault(home)
    const adapter = new BotLlmAdapter({ routes: () => [{ ...ENTRY, baseURL: provider.baseURL }], vault, attachments: () => undefined })
    await assert.rejects(
      collect(adapter.stream({ provider: 'own', model: 'm1', messages: [] })),
      error => error.code === 'MISSING_CREDENTIAL' && error.message.includes('OWN_API_KEY') && !error.message.includes('sk-'),
    )
    process.env.OWN_API_KEY = 'sk-from-env'
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'own', model: 'm1', messages: [] })) chunks.push(chunk)
    assert.deepEqual(chunks.at(-2).block, { type: 'text', text: 'ok' })
  } finally {
    if (env === undefined) delete process.env.OWN_API_KEY
    else process.env.OWN_API_KEY = env
    await provider.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('install registers the directory once it has a route and follows its changes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wire-'))
  try {
    const llm = fakeLlm()
    const ctx = { get: () => undefined, llm }
    // An empty directory registers nothing: an empty initial registration is refused.
    const empty = fakeRuntime({ ctx, home })
    assert.deepEqual(llm.registrations, [])
    assert.deepEqual(empty.rt.ownProviders(), [])

    await empty.rt.setOwnProvider({ id: 'own', protocol: 'openai-completions', baseURL: 'https://api.example.com/v1', models: ['m1'] }, 'sk-a-key')
    assert.deepEqual(llm.registrations.map(entry => entry.providers), [['own']])
    assert.equal(await empty.rt.ownKeyVault.get('OWN_API_KEY'), 'sk-a-key')
    assert.deepEqual(empty.rt.state.providers.own.models, [{ id: 'm1' }])

    await empty.rt.setOwnProvider({ id: 'second', protocol: 'anthropic-messages', baseURL: 'https://api.example.com', models: ['m2'] })
    assert.deepEqual(llm.registrations[0].replaced, [['own', 'second']])

    // A route DSH's own adapters already serve stays with them; the rest still register.
    const taken = fakeLlm({ served: ['own'] })
    const second = fakeRuntime({ ctx: { get: () => undefined, llm: taken }, home })
    await second.rt.setOwnProvider({ id: 'own', protocol: 'openai-completions', baseURL: 'https://api.example.com/v1', models: ['m1'] })
    await second.rt.setOwnProvider({ id: 'mine', protocol: 'openai-responses', baseURL: 'https://api.example.com/v1', models: ['m3'] })
    assert.deepEqual(taken.registrations.map(entry => entry.providers), [['mine']])
    assert.match(second.warnings.join('\n'), /own is served by another adapter/)

    assert.equal(await second.rt.removeOwnProvider('mine'), true)
    assert.deepEqual(taken.registrations[0].replaced, [[]])
    assert.equal(await second.rt.removeOwnProvider('mine'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the identity install is given is the identity the own wire requests send', async () => {
  // Locks the C0.1 attribution fix (plan 2026-10-30 §1.2 gap 3, decision N-01): the
  // registration shell passes the running harness's own identity through install, and
  // both requests this module makes — a streamed call and the models an endpoint reports
  // about itself — name that identity in their User-Agent. A request that went out on
  // the vendor default instead would say deepseek-harness/0.0.1, which is what the thin
  // replacement sent before the identity was threaded through.
  const identity = { product: 'test-harness', version: '9.9.9', url: 'https://example.invalid' }
  const wanted = 'test-harness/9.9.9 (+https://example.invalid)'
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-identity-'))
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, agent: req.headers['user-agent'] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const llm = fakeLlm()
    const { rt } = fakeRuntime({ ctx: { get: () => undefined, llm }, home, identity })
    await rt.setOwnProvider({ id: 'own', protocol: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}`, models: ['m1'] }, 'sk-test')
    // The adapter install registered carries the identity into every request it sends.
    const adapter = llm.registrations[0].adapter
    await collect(adapter.stream({ provider: 'own', model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
    assert.deepEqual(seen, [{ url: '/chat/completions', agent: wanted }])
    // The models an endpoint reports about itself, asked outside any stream, read the
    // same identity off the runtime.
    await discoverWireModels({ protocol: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: 'sk-test', identity: rt.ownIdentity })
    assert.deepEqual(seen.at(-1), { url: '/models', agent: wanted })
  } finally {
    await new Promise(done => server.close(done))
    rmSync(home, { recursive: true, force: true })
  }
})

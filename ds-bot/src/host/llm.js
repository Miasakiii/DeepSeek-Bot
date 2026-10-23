// Phase A of the decouple plan (docs/plans/2026-10-22-decouple-from-dsh.md): the provider
// directory entries, the key vault and the three provider wire clients that DS Bot's own
// LLM adapter will serve on. Nothing here imports DSH and nothing installs it yet — the
// adapter class, the registerAdapter wiring and the request serialization land with the
// rest of phase A, so the running plugin does not change behavior in the meantime.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROTOCOLS, keyRefFor } from './providers.js'
import { replaceFile } from './files.js'

// The wire vocabulary of dsh-llm's StreamChunk, which the phase A adapter has to produce:
// block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish.
// Token usage counts are disjoint: inputTokens is uncached input only, cached input goes
// to cacheReadTokens / cacheWriteTokens. OpenAI-compatible providers fold cache hits into
// their prompt total, so the readers below subtract them back out.

const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

function checkEndpoint(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address')
  return text.replace(/\/+$/, '')
}

// A provider route as the own directory stores it: who to call, on which protocol, with
// which key reference, serving which models. Same shape providers.js shows for DSH routes,
// so the Models page can list either without knowing which side a route lives on.
export function providerEntry(provider) {
  const id = typeof provider?.id === 'string' ? provider.id.trim() : ''
  if (!ROUTE_ID.test(id)) throw invalid('A provider id is lowercase words separated by single dashes')
  if (!PROTOCOLS.includes(provider?.protocol)) throw invalid(`The protocol is one of: ${PROTOCOLS.join(', ')}`)
  const baseURL = checkEndpoint(provider?.baseURL)
  const keyRef = typeof provider?.keyRef === 'string' && provider.keyRef.trim() !== '' ? provider.keyRef.trim() : keyRefFor(id)
  const whole = value => (Number.isInteger(value) && value > 0 ? value : undefined)
  const models = []
  for (const model of Array.isArray(provider?.models) ? provider.models : []) {
    const modelId = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : ''
    if (modelId === '') throw invalid('Every model needs an id')
    const found = typeof model === 'string' ? {} : model
    models.push({
      id: modelId,
      ...(typeof found.name === 'string' && found.name.trim() !== '' ? { name: found.name.trim() } : {}),
      ...(whole(found.contextWindow) ? { contextWindow: found.contextWindow } : {}),
      ...(whole(found.maxTokens) ? { maxTokens: found.maxTokens } : {}),
      ...(Array.isArray(found.input) && found.input.length > 0 ? { input: found.input.filter(kind => typeof kind === 'string') } : {}),
    })
  }
  if (models.length === 0) throw invalid('A provider serves at least one model')
  return {
    id,
    ...(typeof provider?.name === 'string' && provider.name.trim() !== '' ? { name: provider.name.trim() } : {}),
    protocol: provider.protocol,
    baseURL,
    keyRef,
    models,
  }
}

// The key vault: home/keys.json holds every provider key AES-256-GCM encrypted under a
// random 32-byte master key in home/.keys-master (created on first use). Encryption at
// rest keeps a keys.json that escaped the machine — a sync client, an attached log —
// useless; it is not protection against the local user, who owns the master key too.
export function keyVault(home) {
  const keysPath = join(home, 'keys.json')
  const masterPath = join(home, '.keys-master')
  /** @type {Map<string, {iv:string, tag:string, value:string}>|null} */
  let entries = null
  /** @type {Buffer|null} */
  let master = null

  const readMaster = async () => {
    if (master !== null) return master
    try {
      master = Buffer.from(await readFile(masterPath, 'utf8'), 'base64')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      master = randomBytes(32)
      await mkdir(home, { recursive: true })
      await writeFile(masterPath, master.toString('base64'), { encoding: 'utf8', mode: 0o600 })
      await chmod(masterPath, 0o600).catch(() => {})
    }
    if (master.length !== 32) throw new Error('the key vault master key is not 32 bytes')
    return master
  }

  const load = async () => {
    if (entries !== null) return
    entries = new Map()
    try {
      const parsed = JSON.parse(await readFile(keysPath, 'utf8'))
      for (const [ref, entry] of Object.entries(parsed?.entries ?? {})) {
        if (typeof entry?.value === 'string' && typeof entry.iv === 'string' && typeof entry.tag === 'string') {
          entries.set(ref, { iv: entry.iv, tag: entry.tag, value: entry.value })
        }
      }
      await chmod(keysPath, 0o600).catch(() => {})
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const persist = async () => {
    await mkdir(home, { recursive: true })
    const snapshot = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }, null, 2)
    const temp = `${keysPath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600).catch(() => {})
      await replaceFile(temp, keysPath)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  const decrypt = async entry => {
    const key = await readMaster()
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'))
    cipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
    return Buffer.concat([cipher.update(Buffer.from(entry.value, 'base64')), cipher.final()]).toString('utf8')
  }

  return {
    async get(ref) {
      await load()
      const entry = entries.get(ref)
      return entry === undefined ? undefined : decrypt(entry)
    },
    async set(ref, value) {
      await load()
      const key = await readMaster()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      entries.set(ref, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: sealed.toString('base64') })
      await persist()
    },
    async remove(ref) {
      await load()
      if (!entries.delete(ref)) return false
      await persist()
      return true
    },
    async refs() {
      await load()
      return [...entries.keys()]
    },
  }
}

// The request a wire client sends: where, with which headers. Every provider request of
// the phase A adapter must carry the harness attribution headers, so they merge in here
// and the adapter cannot forget them.
export function wireRequest({ protocol, baseURL, apiKey, attribution = {} }) {
  if (!PROTOCOLS.includes(protocol)) throw invalid(`The protocol is one of: ${PROTOCOLS.join(', ')}`)
  const root = checkEndpoint(baseURL)
  if (protocol === 'anthropic-messages') {
    return {
      url: `${root}/v1/messages`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...attribution },
    }
  }
  return {
    url: `${root}/${protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`,
    headers: { authorization: `Bearer ${apiKey}`, ...attribution },
  }
}

// Why a stream failed, in the shapes the phase A adapter maps onto dsh-llm's failure
// kinds: authentication, throttling, the provider's side, the network, or the caller's
// deadline. Throttling, server and network failures are worth another attempt; an
// unauthenticated key is not.
export function wireFailure(kind, message, extra = {}) {
  const retryable = kind === 'rate-limit' || kind === 'server' || kind === 'network' || kind === 'timeout'
  return Object.assign(new Error(message), { kind, retryable, ...extra })
}

const classifyStatus = (status, message) => {
  if (status === 401 || status === 403) return wireFailure('auth', message, { status })
  if (status === 429) return wireFailure('rate-limit', message, { status })
  if (status >= 500) return wireFailure('server', message, { status })
  return wireFailure('request', message, { status })
}

// Server-sent events, split on a blank line; \r\n endings tolerated. Each yielded string
// is one event's joined data payload, with the [DONE] sentinel passed through for the
// protocol readers to see.
async function* sseEvents(body) {
  let buffer = ''
  for await (const part of body) {
    buffer += typeof part === 'string' ? part : Buffer.from(part).toString('utf8')
    for (;;) {
      const cut = buffer.indexOf('\n\n')
      const cutCr = buffer.indexOf('\r\n\r\n')
      const end = cutCr !== -1 && (cut === -1 || cutCr < cut) ? cutCr : cut
      if (end === -1) break
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + (end === cutCr ? 4 : 2))
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (data !== '') yield data
    }
  }
}

// Block bookkeeping the three readers share: blocks in arrival order, the one currently
// open, and the block-end each closed block assembles from its deltas.
function blockTracker() {
  /** @type {{kind:'text'|'reasoning'|'tool-call', text:string, calls:{id:string,name:string}, closed?:boolean, at?:number}[]} */
  const blocks = []
  const start = (kind, calls) => {
    const block = { kind, text: '', calls: calls ?? { id: '', name: '' } }
    blocks.push(block)
    return { index: blocks.length - 1, block, chunk: { type: 'block-start', index: blocks.length - 1, blockType: kind } }
  }
  const close = index => {
    const block = blocks[index]
    if (block === undefined || block.closed) return undefined
    block.closed = true
    if (block.kind === 'text') return { type: 'block-end', index, block: { type: 'text', text: block.text } }
    if (block.kind === 'reasoning') return { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
    return { type: 'block-end', index, block: { type: 'tool-call', id: block.calls.id, name: block.calls.name, arguments: block.text } }
  }
  return {
    start,
    close,
    blocks,
    get current() { return blocks.length === 0 || blocks[blocks.length - 1].closed ? undefined : blocks.length - 1 },
  }
}

const finishOf = reason => {
  if (reason === 'tool_calls' || reason === 'tool_use') return { kind: 'tool-calls' }
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

const usageOfOpenAi = (prompt, cached, completion, total) => ({
  inputTokens: prompt - cached,
  outputTokens: completion,
  ...(total !== undefined ? { totalTokens: total } : {}),
  ...(cached > 0 ? { cacheReadTokens: cached } : {}),
})

// OpenAI chat completions: choices[0].delta carries the phases (reasoning, text, tool
// calls) one at a time, so the translator opens a block per phase and closes it when the
// phase changes. prompt_tokens counts cached input too, so the cached part is subtracted.
async function* openaiCompletions(events) {
  const tracker = blockTracker()
  let phase = null
  let toolKey = null
  /** An id seen on a tool call's first chunk, keyed by the call index its later chunks carry. */
  const toolIds = new Map()
  let usage = null
  let reason = 'stop'
  for await (const data of events) {
    if (data === '[DONE]') break
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }
    if (parsed?.usage !== undefined) {
      usage = usageOfOpenAi(parsed.usage.prompt_tokens ?? 0, parsed.usage.prompt_tokens_details?.cached_tokens ?? 0, parsed.usage.completion_tokens ?? 0, parsed.usage.total_tokens)
    }
    const choice = parsed?.choices?.[0]
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) reason = choice.finish_reason
    if (choice?.delta === undefined) continue
    const delta = choice.delta
    if (delta.tool_calls?.length > 0) {
      const call = delta.tool_calls[0]
      const slot = call.index ?? 0
      if (call.id !== undefined) toolIds.set(slot, String(call.id))
      const key = call.id !== undefined ? String(call.id) : toolIds.get(slot)
      if (key !== toolKey) {
        if (tracker.current !== undefined) yield tracker.close(tracker.current)
        toolKey = key
        const opened = tracker.start('tool-call', { id: call.id !== undefined ? String(call.id) : key ?? '', name: call.function?.name ?? '' })
        yield opened.chunk
      }
      const index = tracker.current
      if (call.function?.name !== undefined && call.function.name !== '' && tracker.blocks[index].calls.name === '') tracker.blocks[index].calls.name = call.function.name
      if (call.function?.arguments) {
        tracker.blocks[index].text += call.function.arguments
        yield { type: 'tool-call-delta', index, id: tracker.blocks[index].calls.id, ...(tracker.blocks[index].calls.name !== '' ? { name: tracker.blocks[index].calls.name } : {}), argumentsDelta: call.function.arguments }
      }
      phase = 'tool-call'
      continue
    }
    const next = delta.reasoning_content !== undefined ? 'reasoning' : delta.content !== undefined ? 'text' : null
    if (next === null) continue
    if (next !== phase) {
      if (tracker.current !== undefined) yield tracker.close(tracker.current)
      phase = next
      toolKey = null
      toolIds.clear()
      yield tracker.start(next).chunk
    }
    const text = (next === 'reasoning' ? delta.reasoning_content : delta.content) ?? ''
    tracker.blocks[tracker.current].text += text
    yield { type: next === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: tracker.current, text }
  }
  if (tracker.current !== undefined) yield tracker.close(tracker.current)
  if (usage !== null) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finishOf(reason) }
}

// OpenAI responses: the server narrates output items (message, reasoning, function_call)
// one at a time; text and call arguments arrive as named delta events for the current
// item, and the run ends with response.completed (or .incomplete at the token ceiling).
async function* openaiResponses(events) {
  const tracker = blockTracker()
  let usage = null
  let toolCalls = 0
  let incomplete = false
  for await (const data of events) {
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }
    const type = parsed?.type
    if (type === 'response.output_item.added') {
      if (tracker.current !== undefined) yield tracker.close(tracker.current)
      const item = parsed.item ?? {}
      if (item.type === 'function_call') {
        toolCalls += 1
        yield tracker.start('tool-call', { id: String(item.call_id ?? item.id ?? ''), name: item.name ?? '' }).chunk
      } else if (item.type === 'reasoning') {
        yield tracker.start('reasoning').chunk
      } else {
        yield tracker.start('text').chunk
      }
      continue
    }
    const index = tracker.current
    const block = index === undefined ? undefined : tracker.blocks[index]
    if (type === 'response.output_text.delta' && block?.kind === 'text') {
      block.text += parsed.delta ?? ''
      yield { type: 'text-delta', index, text: parsed.delta ?? '' }
    } else if (type === 'response.reasoning_text.delta' && block?.kind === 'reasoning') {
      block.text += parsed.delta ?? ''
      yield { type: 'reasoning-delta', index, text: parsed.delta ?? '' }
    } else if (type === 'response.function_call_arguments.delta' && block?.kind === 'tool-call') {
      block.text += parsed.delta ?? ''
      yield { type: 'tool-call-delta', index, id: block.calls.id, argumentsDelta: parsed.delta ?? '' }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = parsed.response ?? {}
      const u = response.usage ?? {}
      usage = usageOfOpenAi(u.input_tokens ?? 0, u.input_tokens_details?.cached_tokens ?? 0, u.output_tokens ?? 0, u.total_tokens)
      incomplete = type === 'response.incomplete'
    }
  }
  if (tracker.current !== undefined) yield tracker.close(tracker.current)
  if (usage !== null) yield { type: 'usage', usage }
  yield { type: 'finish', reason: incomplete ? { kind: 'max-tokens' } : toolCalls > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } }
}

// Anthropic messages: content blocks with their own indexes, thinking deltas for
// reasoning, input_json_delta for call arguments. input_tokens already excludes cache
// reads and writes, which arrive as their own fields; output_tokens arrives last, on
// message_delta.
async function* anthropicMessages(events) {
  const tracker = blockTracker()
  let usage = null
  let outputTokens = 0
  let reason = null
  const kinds = { text: 'text', thinking: 'reasoning', tool_use: 'tool-call' }
  for await (const data of events) {
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }
    const type = parsed?.type
    if (type === 'error') {
      const kind = parsed.error?.type === 'authentication_error' || parsed.error?.type === 'permission_error' ? 'auth' : 'server'
      throw wireFailure(kind, parsed.error?.message ?? 'the provider reported an error')
    }
    if (type === 'message_start') {
      const u = parsed.message?.usage ?? {}
      usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: 0,
        ...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
        ...(u.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
      }
      continue
    }
    if (type === 'content_block_start') {
      const kind = kinds[parsed.content_block?.type]
      if (kind === undefined) continue
      const opened = kind === 'tool-call'
        ? tracker.start('tool-call', { id: String(parsed.content_block.id ?? ''), name: parsed.content_block.name ?? '' })
        : tracker.start(kind)
      opened.block.at = parsed.index
      yield opened.chunk
      continue
    }
    if (type === 'content_block_delta') {
      const delta = parsed.delta ?? {}
      const index = tracker.blocks.findIndex(block => block.at === parsed.index && !block.closed)
      if (index === -1) continue
      const block = tracker.blocks[index]
      if (delta.type === 'text_delta') {
        block.text += delta.text ?? ''
        yield { type: 'text-delta', index, text: delta.text ?? '' }
      } else if (delta.type === 'thinking_delta') {
        block.text += delta.thinking ?? ''
        yield { type: 'reasoning-delta', index, text: delta.thinking ?? '' }
      } else if (delta.type === 'input_json_delta') {
        block.text += delta.partial_json ?? ''
        yield { type: 'tool-call-delta', index, id: block.calls.id, ...(block.calls.name !== '' ? { name: block.calls.name } : {}), argumentsDelta: delta.partial_json ?? '' }
      }
      continue
    }
    if (type === 'message_delta') {
      if (parsed.usage?.output_tokens !== undefined) outputTokens = parsed.usage.output_tokens
      if (parsed.delta?.stop_reason != null) reason = parsed.delta.stop_reason
    }
  }
  for (let index = 0; index < tracker.blocks.length; index += 1) {
    const closed = tracker.close(index)
    if (closed !== undefined) yield closed
  }
  if (usage !== null) yield { type: 'usage', usage: { ...usage, outputTokens } }
  yield { type: 'finish', reason: reason === null ? { kind: 'stop' } : finishOf(reason) }
}

const PARSERS = {
  'openai-completions': openaiCompletions,
  'openai-responses': openaiResponses,
  'anthropic-messages': anthropicMessages,
}

// Stream one call over one of the three protocols and yield the StreamChunk sequence.
// The request body is the caller's to build; this side owns transport, status mapping
// and the wire-to-chunk translation.
export async function* streamWire({ protocol, baseURL, apiKey, body, signal, attribution, fetchImpl = fetch }) {
  if (PARSERS[protocol] === undefined) throw invalid(`The protocol is one of: ${PROTOCOLS.join(', ')}`)
  const request = wireRequest({ protocol, baseURL, apiKey, attribution })
  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
      ...(typeof body !== 'string' ? { duplex: 'half' } : {}),
    })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw wireFailure('timeout', 'the provider did not answer in time')
    throw wireFailure('network', `could not reach the provider: ${error?.message ?? 'network error'}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyStatus(response.status, text.trim() !== '' ? text.trim().slice(0, 500) : `the provider answered ${response.status}`)
  }
  if (response.body === null) throw wireFailure('server', 'the provider sent no body')
  yield* PARSERS[protocol](sseEvents(response.body))
}

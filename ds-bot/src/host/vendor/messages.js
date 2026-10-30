import { randomUUID } from 'node:crypto'

// The Session message shapes DSH hands around, built here so ds-bot's own code and tests
// do not need the package. A message is a value: the caller's objects are copied, and the
// copy is frozen at every level, so a later writer cannot change what a Session recorded.

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

const seal = fields => deepFreeze(structuredClone(fields))

export function createUserMessage({ content, source, ...rest } = {}) {
  return seal({
    ...(content === undefined ? {} : { content }),
    ...(source === undefined ? {} : { source }),
    ...rest,
    role: 'user',
    id: randomUUID(),
  })
}

export function createAssistantMessage({ content, source = {} } = {}) {
  return seal({
    role: 'assistant',
    ...(content === undefined ? {} : { content }),
    source: { kind: 'model', ...source },
    id: randomUUID(),
  })
}

export function createSystemMessage(text) {
  return seal({
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
    id: randomUUID(),
  })
}

export function createToolResultMessage({ callId, content, isError }) {
  return seal({
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content,
    isError,
    id: randomUUID(),
  })
}

// The stream an adapter yields: block-start, text-delta, reasoning-delta, tool-call-delta,
// block-end, usage, finish. A block opens implicitly with its first delta; a block-end
// carries the finished block it closes.
function emptyBlock(type) {
  if (type === 'tool-call') return { type, id: '', name: '', arguments: '' }
  if (type === 'text' || type === 'reasoning') return { type, text: '' }
  throw new Error(`cannot assemble incomplete block of type "${type}"`)
}

const finishOf = block => (block.type === 'tool-call'
  ? { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }
  : { type: block.type, text: block.text })

export class BlockAssembler {
  #blocks = []
  #usage
  #finish = { kind: 'stop' }

  push(chunk) {
    switch (chunk?.type) {
      case 'block-start':
        this.#open(chunk.index, chunk.blockType)
        return
      case 'block-end':
        this.#blocks[chunk.index] = { block: chunk.block, closed: true }
        return
      case 'text-delta':
        this.#open(chunk.index, 'text').block.text += chunk.text ?? ''
        return
      case 'reasoning-delta':
        this.#open(chunk.index, 'reasoning').block.text += chunk.text ?? ''
        return
      case 'tool-call-delta': {
        const { block } = this.#open(chunk.index, 'tool-call')
        if (chunk.id !== undefined) block.id = chunk.id
        if (chunk.name !== undefined) block.name = chunk.name
        block.arguments += chunk.argumentsDelta ?? ''
        return
      }
      case 'usage':
        this.#usage = chunk.usage
        return
      case 'finish':
        this.#finish = chunk.reason
        return
      default:
        throw new Error(`unknown stream chunk: ${String(chunk?.type)}`)
    }
  }

  blocks() {
    return this.#blocks
      .filter(entry => entry !== undefined)
      .map(entry => (entry.closed ? entry.block : finishOf(entry.block)))
  }

  get usage() {
    return this.#usage
  }

  get finish() {
    return this.#finish
  }

  #open(index, type) {
    const entry = this.#blocks[index]
    if (entry !== undefined && entry.closed !== true && entry.block.type === type) return entry
    const fresh = { block: emptyBlock(type), closed: false }
    this.#blocks[index] = fresh
    return fresh
  }
}

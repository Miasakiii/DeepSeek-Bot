// The harness error a service raises with a stable code, and the LLM errors the adapter
// raises in front of it. Both keep what a caller reads: the code, and for a model failure
// the failure record the turn reports.
export class HarnessError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = new.target.name
  }
}

export class LlmError extends HarnessError {
  constructor(message, code, failure) {
    if (typeof code !== 'string' || code === '') throw new Error('LlmError code must be a non-empty string')
    super(message, code)
    this.failure = { message, code, ...failure }
  }
}

export function isHarnessError(error) {
  return error instanceof HarnessError
}

// The key a provider call needs: trimmed, and refused when blank with a message that names
// the reference to set and never shows a value.
export function assertUsableApiKey(raw, product, ref) {
  const key = raw.trim()
  if (key === '') {
    throw new LlmError(`${product}: the API key resolved from ${ref} is blank; set ${ref} to the raw key (the web Models page writes it) or export it in the launching environment`, 'INVALID_CREDENTIAL')
  }
  return key
}

// What a provider sees of the client that calls it. DS Bot runs on DeepSeek Harness, so the
// header names the harness; the DSH shell passes the running harness's own identity.
const HARNESS = { product: 'deepseek-harness', version: '0.0.1', url: 'https://github.com/deepseek-ai/deepseek-harness' }

export function attributionHeaders(product = HARNESS) {
  return { 'user-agent': `${product.product}/${product.version} (+${product.url})` }
}

const shortId = attachment => `sha256:${String(attachment?.attachmentId ?? '').replace(/^sha256:/, '').slice(0, 8)}`

// How a message names an uploaded file: a copy saved where the model's tools can read it,
// or, when no readable path exists, a plain statement of that limit.
export function fileHandleText(attachment, path) {
  const head = `[File "${String(attachment?.name)}" (${String(attachment?.bytes)} bytes, ${shortId(attachment)})`
  if (typeof path !== 'string' || path === '') {
    return `${head} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `${head}: verbatim read-only copy saved at "${path}". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

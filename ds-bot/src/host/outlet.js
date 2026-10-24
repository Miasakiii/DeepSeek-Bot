// The plugin's own HTTP outlet (phase B1 of the decouple plan): a node:http server that
// serves the same POST /api/bot channel and SSE feed the browser uses, plus the window's
// static files, authenticated with the plugin's own token. It runs beside DSH's
// connection route — which keeps serving a window that still loads DSH's web front end —
// so one `handle` and one feed reach every window whatever carries them.
//
// It listens on the loopback only: a LAN bind is a later phase's question. It stays off
// until the config names a port, so the plugin form (DSH web) is unaffected.
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { normalize, resolve, sep } from 'node:path'
import { FEED_ROUTE } from './feed.js'
import { ROUTE } from './constants.js'

// One request body, bounded: the channel takes JSON payloads, and a window that sends
// more than this is not a window this outlet serves.
const MAX_BODY_BYTES = 8 * 1024 * 1024
// A window that stops reading fills the socket buffer; past this many waiting events it
// is dropped and reconnects from `hello`.
const MAX_QUEUED_EVENTS = 512
// The token travels in a header or, for an EventSource that cannot set one, in the query.
const TOKEN_HEADER = 'authorization'
const TOKEN_QUERY = 'token'
// Set on the first answer, so a window that reloads keeps its session.
const COOKIE_NAME = 'dsbot-outlet'

const unauthorized = { code: 'bot/unauthorized', message: 'A valid token is required' }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const guessType = path => TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'

const readBody = (request, signal) => new Promise((resolveBody, reject) => {
  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk)
  })
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
  signal?.addEventListener('abort', () => reject(new Error('the request was aborted')), { once: true })
})

export function install(rt) {
  const { ctx, config } = rt
  // A positive port is bound as given; 0 lets the system pick a free one; anything else
  // (absent included) leaves the outlet off, so the plugin form is untouched.
  const port = Number.isInteger(config.outletPort) && config.outletPort >= 0 ? config.outletPort : undefined
  if (port === undefined) return
  const token = typeof config.outletToken === 'string' && config.outletToken !== '' ? config.outletToken : randomUUID()
  const root = typeof config.outletRoot === 'string' && config.outletRoot !== '' ? resolve(config.outletRoot) : undefined

  // The token, or the cookie the first answer sets: a window that reloads keeps its
  // session without the token in the address bar.
  const allowed = (url, request) => {
    const header = request.headers[TOKEN_HEADER]
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (bearer === token) return true
    if (url.searchParams.get(TOKEN_QUERY) === token) return true
    const cookie = request.headers.cookie
    return typeof cookie === 'string' && cookie.split(';').some(part => part.trim() === `${COOKIE_NAME}=${token}`)
  }
  const cookie = () => `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`
  const json = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      // Only an answer that passed the check starts a session.
      ...(status < 400 ? { 'set-cookie': cookie() } : {}),
    })
    res.end(body)
  }

  const post = async (request, res, signal) => {
    let payload
    try {
      payload = JSON.parse(await readBody(request, signal) || '{}')
    } catch (error) {
      if (signal?.aborted === true) return
      json(res, 400, { ok: false, error: { code: 'bot/invalid', message: error?.message ?? 'unreadable body' } })
      return
    }
    const result = await rt.botChannel(String(payload?.endpoint ?? ''), payload?.payload, signal)
    json(res, 200, result)
  }

  const feed = (res) => {
    // A window that stops reading fills the socket buffer; past this many waiting
    // events it is dropped and reconnects from `hello`.
    let queued = 0
    const sink = {
      send: (chunk) => {
        if (res.writableEnded || res.destroyed) return false
        queued += 1
        const drained = res.write(chunk)
        if (!drained && queued > MAX_QUEUED_EVENTS) return false
        return true
      },
      close: () => { try { res.end() } catch { /* already ended */ } },
    }
    res.on('drain', () => { queued = 0 })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
    rt.feedJoin(sink)
    res.on('close', () => rt.feedLeave(sink))
  }

  const file = async (res, pathname) => {
    if (root === undefined) {
      json(res, 404, { ok: false, error: { code: 'bot/not-found', message: 'This outlet serves no files' } })
      return
    }
    const wanted = resolve(root, normalize(pathname).replace(/^([\\/]+)/, ''))
    if (wanted !== root && !wanted.startsWith(root + sep)) {
      json(res, 403, { ok: false, error: { code: 'bot/refused', message: 'That path is outside the served folder' } })
      return
    }
    const target = wanted === root ? resolve(root, 'index.html') : wanted
    const info = await stat(target).catch(() => undefined)
    if (info?.isFile() !== true) {
      json(res, 404, { ok: false, error: { code: 'bot/not-found', message: 'No such file' } })
      return
    }
    // The document a window opens with its token is its first answer; the session that
    // answer starts is what the page's own asset requests then ride.
    res.writeHead(200, { 'content-type': guessType(target), 'content-length': info.size, 'set-cookie': cookie() })
    createReadStream(target).pipe(res)
  }

  const server = createServer((request, res) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!allowed(url, request)) {
      json(res, 401, { ok: false, error: unauthorized })
      return
    }
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const { pathname } = url
    if (request.method === 'POST' && pathname === ROUTE) {
      void post(request, res, controller.signal).catch((error) => {
        if (!res.writableEnded) json(res, 500, { ok: false, error: { code: 'bot/internal', message: error?.message ?? String(error) } })
      })
      return
    }
    if (request.method === 'GET' && pathname === FEED_ROUTE) {
      feed(res)
      return
    }
    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      void file(res, '/index.html').catch(() => json(res, 500, { ok: false, error: { code: 'bot/internal', message: 'the file could not be read' } }))
      return
    }
    if (request.method === 'GET' && root !== undefined) {
      void file(res, pathname).catch(() => json(res, 500, { ok: false, error: { code: 'bot/internal', message: 'the file could not be read' } }))
      return
    }
    json(res, 404, { ok: false, error: { code: 'bot/not-found', message: `No route ${request.method} ${pathname}` } })
  })

  let ready
  const readyPromise = new Promise((resolve, reject) => { ready = { resolve, reject } })
  // Nothing hangs on the port when the bind fails, so the rejection stays handled until
  // a caller asks for it.
  readyPromise.catch(() => {})
  server.listen(port, '127.0.0.1', () => {
    // The token is a secret: it is printed once, at the start, for whoever launches the
    // window; nothing logs it again.
    console.info(`ds-bot: own outlet on http://127.0.0.1:${server.address().port} (token ${token})`)
    ready.resolve({ port: server.address().port, token })
  })
  server.on('error', (error) => {
    rt.warn('ds-bot: the own outlet on port %d failed: %s', port, error?.message ?? error)
    ready.reject(error)
  })

  ctx.effect(() => () => server.close(), 'ds-bot: own outlet')
  Object.assign(rt, {
    outletToken: () => token,
    outletPort: () => server.address()?.port ?? null,
    // The bound port and token, once the outlet listens: what launches a window needs.
    outletReady: () => readyPromise,
  })
}

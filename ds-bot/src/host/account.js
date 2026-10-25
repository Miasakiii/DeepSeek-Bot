// The DeepSeek account of DSH's own settings, for a window that rides no shell of its
// own and so carries no account plugin (the desktop app's own window). Everything here
// forwards to DSH's documented account service: the login stays its OAuth flow, with
// the loopback callback registered on the engine's web server, and the answers carry
// only the states the service reports — no token ever crosses this channel.

import { readFileSync } from 'node:fs'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const unavailable = message => Object.assign(new Error(message), { code: 'bot/unavailable' })

// The state the windows see: exactly the service's AccountView fields, dropped to null
// when the service is not there.
const trim = view => (view === undefined || view === null ? null : { status: view.status, links: view.links, attempt: view.attempt ?? null })

// What the requesting window is, as the service's client metadata describes it. The
// timezone offset arrives in seconds east of Greenwich; anything else is none.
function clientMeta(body) {
  const offset = Number(body?.timezoneOffsetSeconds)
  return {
    version: PKG.version,
    locale: typeof body?.locale === 'string' && body.locale !== '' ? body.locale.slice(0, 20) : 'en',
    timezoneOffsetSeconds: Number.isInteger(offset) && Math.abs(offset) <= 14 * 3600 ? offset : 0,
  }
}

export function install(rt) {
  const { ctx } = rt

  const service = () => {
    const account = ctx.get?.('deepseekAccount')
    if (account === undefined) throw unavailable('This DSH has no DeepSeek account service')
    return account
  }

  async function accountView() {
    const account = ctx.get?.('deepseekAccount')
    if (account === undefined) return { available: false, state: null }
    return { available: true, state: trim(await account.getState()) }
  }

  // The browser authorization: the web server's origin is the loopback callback the
  // account provider registers its /oauth/callback on, and the desktop flow is what
  // this window is. The service starts a fresh authorization whatever a stored login
  // says, and the new grant replaces the stored one when it lands, so a signed-in
  // account answers with its own state instead of being asked to log in again.
  async function accountStart(body) {
    const account = service()
    const current = trim(await account.getState())
    if (current.status === 'credential-stored') return current
    const webServer = ctx.get?.('webServer')
    if (webServer === undefined) throw unavailable('The engine\'s web server is off, so the sign-in has no callback')
    return trim(await account.startSignIn(clientMeta(body), webServer.getOrigin(), 'desktop'))
  }

  async function accountCancel(body) {
    const id = String(body?.id ?? '')
    if (id === '') throw Object.assign(new Error('No sign-in attempt named'), { code: 'bot/invalid' })
    return trim(await service().cancelSignIn(id))
  }

  async function accountSignOut(body) {
    return trim(await service().signOut(clientMeta(body)))
  }

  // The feed's account news only refreshes a team's view (the served models change
  // with the login); the own sign-in dialog follows the attempt itself, polling the
  // host's account state every two seconds, and closes when a poll reads it finished.
  ctx.effect(() => {
    const account = ctx.get?.('deepseekAccount')
    if (account === undefined || typeof account.watch !== 'function') return () => {}
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const view of account.watch(controller.signal)) rt.accountNews?.(trim(view))
      } catch { /* the service went away with its window */ }
    })()
    return () => controller.abort()
  }, 'ds-bot: account news')

  Object.assign(rt, { accountView, accountStart, accountCancel, accountSignOut })
}

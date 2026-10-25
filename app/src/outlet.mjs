// The app's own window: the UI in ui/dist, served by ds-bot's own HTTP outlet (phase B1
// of the decouple plan) on a loopback port of its own. The port is stable across starts,
// because the page keeps its storage per origin; the token is fresh at every start and
// reaches the plugin through a profile patch the Host writes. DS_BOT_OWN_UI=0, or a build
// that is missing, falls back to DSH's web front end, which is the documented rollback
// while the own UI catches up.
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hostPort } from './host-port.mjs'

export const OUTLET_PATCH_NAME = 'own-outlet.patch.yml'
// How long the Host waits for the outlet to listen before it falls back.
export const OUTLET_TIMEOUT_MS = 60_000

/**
 * The outlet's address for this start, or undefined when the own window is off or its
 * build is missing.
 * @param {string} userData - where the app keeps its own files
 * @param {string} uiRoot - the built window (ui/dist)
 * @returns {Promise<{port: number, token: string, root: string} | undefined>}
 */
export async function outletPlan(userData, uiRoot) {
  if (process.env.DS_BOT_OWN_UI === '0') return undefined
  if (!existsSync(join(uiRoot, 'index.html'))) return undefined
  const port = await hostPort(join(userData, 'outlet-port.json'))
  return { port, token: randomUUID(), root: uiRoot }
}

/** The window's origin: the outlet's when it serves the window, else DSH's. */
export const outletOrigin = ({ port }) => `http://127.0.0.1:${port}`

/** The launch URL, which carries the token once. */
export const outletUrl = ({ port, token }) => `${outletOrigin({ port })}/?token=${token}`

/** The profile patch rows that point the plugin at the outlet. */
export const outletPatchRows = ({ port, token, root }) => [{
  id: 'miasaki-bot',
  name: 'miasaki-dsbot',
  config: { outletPort: port, outletToken: token, outletRoot: root },
}]

const reachable = port => new Promise((resolve) => {
  const socket = createConnection({ port, host: '127.0.0.1' })
  socket.once('error', () => { socket.destroy(); resolve(false) })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
})

/**
 * Wait until the outlet answers a connection: the plugin binds it while the profile boots.
 * @returns {Promise<boolean>} whether it came up in time
 */
export async function outletUp(port, timeoutMs = OUTLET_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await reachable(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

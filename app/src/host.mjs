// The Host: the shell runs this file in Electron's Node mode. It boots the app's own `miasaki-dsbot` profile
// on a loopback port and reports the launch URL over IPC. With DS_BOT_CHECK, the path of a JSON list
// of Session ids, it boots the first-run check's profile instead and reports which of them it cannot read.
// Follows DeepSeek Harness apps/desktop-host/src/index.ts (MIT); see NOTICE.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { stringify } from 'yaml'
import { CHECK_PROFILE, INSTALL_ANCHOR, loadAppProfile, loadCheckProfile, OWN_SERVICES_PATCH_NAME, ownServicesPatchRows, PROFILE } from './profile.mjs'
import { outletPatchRows, outletUp, outletUrl, OUTLET_PATCH_NAME, OUTLET_TIMEOUT_MS } from './outlet.mjs'
import { reconcileSearchSelector } from './search-patch.mjs'
import { unreadableSessions } from './session-check.mjs'

const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

const send = (message) => new Promise((resolve, reject) => {
  if (!process.connected || process.send === undefined) { resolve(); return }
  process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
})

// The own window's outlet as the shell asked for it: a port, a token and the built UI.
const outletFromEnv = (env) => {
  const port = Number(env.DS_BOT_OUTLET_PORT)
  const root = env.DS_BOT_OUTLET_ROOT ?? ''
  if (!Number.isInteger(port) || port <= 0 || env.DS_BOT_OUTLET_TOKEN === undefined || !existsSync(join(root, 'index.html'))) return undefined
  return { port, token: env.DS_BOT_OUTLET_TOKEN, root }
}

const writeOutletPatch = (profileDir, outlet) => {
  const file = join(dirname(profileDir), OUTLET_PATCH_NAME)
  writeFileSync(file, stringify(outletPatchRows(outlet)), 'utf8')
  return file
}

// The own window's profile mounts no web-app bundle, so the front end's services that the
// Bot team runs on come through an overlay beside the profiles, read only through `patchFiles`.
const writeOwnServicesPatch = (profileDir) => {
  const file = join(dirname(profileDir), OWN_SERVICES_PATCH_NAME)
  writeFileSync(file, stringify(ownServicesPatchRows()), 'utf8')
  return file
}

async function main() {
  const pnpm = process.argv[2]
  const check = process.env.DS_BOT_CHECK || undefined
  // The own window's outlet, which the shell asked for: its rows go into a patch beside
  // the profiles, read only through `patchFiles`. No outlet is the rollback window mode,
  // in which the window rides DSH's Web front end; the profile's bundles follow that mode.
  const outlet = check === undefined ? outletFromEnv(process.env) : undefined
  const profile = check === undefined ? loadAppProfile(outlet !== undefined) : loadCheckProfile()
  reportSkippedBundles('dsh', profile)
  const patchFiles = [
    ...(outlet === undefined ? [] : [writeOutletPatch(profile.dir, outlet), writeOwnServicesPatch(profile.dir)]),
    ...(check === undefined ? reconcileSearchSelector(profile) : []),
  ]
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: check === undefined ? PROFILE : CHECK_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles,
    args: ['--no-open', '--port', process.env.DS_BOT_PORT || '0'],
    ...(pnpm === undefined ? {} : {
      packageManager: { command: process.execPath, args: ['--expose-internals', pnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }),
  })
  let stopping
  const stop = () => stopping ??= (async () => {
    // A Host that failed to boot has nothing to shut down; the shell already has the failure.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message) => { if (message?.type === 'shutdown') void stop() })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  if (check !== undefined) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error(`The profile in ${profile.dir} does not store Sessions.`)
    await send({ type: 'checked', unreadable: await unreadableSessions(persistence, JSON.parse(readFileSync(check, 'utf8'))) })
    return
  }
  const [webServer, connection] = [ctx.get('webServer'), ctx.get('connection')]
  // The own window: the outlet answers the port the shell picked, and the launch URL
  // carries its token once.
  if (outlet !== undefined && await outletUp(outlet.port, OUTLET_TIMEOUT_MS)) {
    await send({ type: 'ready', url: outletUrl(outlet), injections: [] })
    return
  }
  // The own window has no front end to fall back to: this profile mounts no web server,
  // and the outlet is the window's only way in.
  if (outlet !== undefined) throw new Error(`The own window's outlet did not answer its port within ${String(OUTLET_TIMEOUT_MS / 1000)} seconds.`)
  // A profile patch can turn these rows off; then the window has nothing to talk to.
  if (webServer === undefined || connection === undefined) throw new Error(`The profile in ${profile.dir} does not start the engine's web server and connection.`)
  const url = connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`)
  await send({ type: 'ready', url, injections: webServer.collectIndexInjections() })
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
  await send({ type: 'fatal', message, diagnostic }).catch(() => undefined)
  if (process.connected) process.disconnect()
})

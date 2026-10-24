// The app's own DSH profile: its name, its bundles and its installation.
import { fileURLToPath } from 'node:url'
import { initProfile, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

export const PROFILE = 'miasaki-dsbot'
// The profile's bundles in the two window modes. With the own window (phase B1) the outlet is
// the window's only way in, so the profile goes without DSH's Web front end and its web server;
// the rollback (`DS_BOT_OWN_UI=0`, or a missing build) keeps the front end the window rides on.
// In both modes DSH's shared core comes first, then the Bot team; user bundles follow.
export const OWN_WINDOW_BUNDLES = ['@deepseek-ai/dsh-base', 'miasaki-dsbot']
export const DSH_WINDOW_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'miasaki-dsbot']
// The first-run check reads a copy of the team's chats without the Bot team running on them.
// DSH reads a log the same way whatever the profile mounts; the Session log it reads is
// dsh-base's, so the check needs no more than that.
export const CHECK_PROFILE = 'import-check'
export const CHECK_BUNDLES = ['@deepseek-ai/dsh-base']
// Bundles that claimBundles strips from an earlier profile: `deepseek-bot-engine` is gone for
// good (the engine layer of the app's own window, ../engine). `@deepseek-ai/dsh-web-app` is
// retired only while the own window is on: the rollback mode lists it again, and this entry is
// what strips it from a profile that an own-window start has already rewritten. Do not drop
// it — without it the own mode leaves the front end mounted.
const RETIRED_BUNDLES = ['deepseek-bot-engine', '@deepseek-ai/dsh-web-app']
// The service rows of DSH's Web front end that the Bot team still runs on: its plugin injects
// them (a Session turn goes through `sessionController`, which needs `fileUploads`, whose row
// needs `connection`). The own window's profile, which mounts no web-app bundle, supplies the
// rows through this overlay instead. `connection` keeps its schema defaults: nothing serves
// its routes in this mode — the outlet is the window's only way in.
export const OWN_SERVICES_PATCH_NAME = 'own-services.patch.yml'

/** The overlay rows that carry the front end's services into the own window's profile. */
export function ownServicesPatchRows() {
  return [{ insert: [
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
    { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
    { id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
  ] }]
}
// The app's own manifest is the installation: DSH imports plugins only from the installation's dependency
// graph, resolves bundles there first, and keeps the bundles it names as direct dependencies from removal.
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Put the mode's bundles at the head of a profile's bundle list and keep the user's after
 * them. initProfile writes the list only into a new profile, so a profile from an earlier
 * build — or from a start in the other window mode — keeps its old list until this rewrites it.
 * @param {string} dir - the profile directory
 * @param {string[]} bundles - the window mode's bundle list
 */
export function claimBundles(dir, bundles) {
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const next = [...bundles, ...listed.filter((name) => !bundles.includes(name) && !RETIRED_BUNDLES.includes(name))]
  if (next.join('\n') !== listed.join('\n')) writeProfileBundles(dir, manifest, next)
}

/**
 * Create or update the profile under the current DSH_HOME and load it.
 * @param {boolean} ownWindow - whether the own window serves the app's window, which drops
 *   DSH's Web front end from the profile
 * @returns {import('@deepseek-ai/dsh-app-boot').Profile} the loaded profile
 * @throws when one of the app's own bundles does not load
 */
export function loadAppProfile(ownWindow) {
  const bundles = ownWindow ? OWN_WINDOW_BUNDLES : DSH_WINDOW_BUNDLES
  const dir = resolveProfileDir(PROFILE)
  initProfile(dir, bundles)
  claimBundles(dir, bundles)
  return loadOwnBundles(dir, bundles)
}

/** The profile of the first-run check, under the current DSH_HOME. */
export function loadCheckProfile() {
  const dir = resolveProfileDir(CHECK_PROFILE)
  initProfile(dir, CHECK_BUNDLES)
  return loadOwnBundles(dir, CHECK_BUNDLES)
}

function loadOwnBundles(dir, bundles) {
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const lost = profile.skippedBundles.filter(({ packageName }) => bundles.includes(packageName))
  if (lost.length > 0) throw new Error(`The app could not load its own bundles:\n${lost.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('\n')}`)
  return profile
}

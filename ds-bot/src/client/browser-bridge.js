// Bot browsers in the app's own window (phase B1 of the decouple plan): the same bridge
// DSH Desktop gives the plugin's client, provided by the page itself. A lease names one
// guest for its life; the same key always yields the same storage partition, so a Bot's
// cookies and logins never cross into another Bot while one Bot may hold several pages.
// The guests are `<webview>` elements the page creates, so this side only mints leases
// and hears their open requests: no main-process round trip, no IPC.
//
// The page provides the bridge because the window's sandboxed preload cannot require
// modules: `installOwnBrowserBridge` runs where the page carries the app's `dsBotApp`
// (either of the desktop app's window modes) and no `dshDesktop` was given. DSH
// Desktop's real bridge always wins, and a plain DSH web window gets none, as before.

const PARTITION_PREFIX = 'persist:bot-'
export { PARTITION_PREFIX }
// A partition name is a file name: keep it to characters that survive every file system.
const safeKey = key => String(key ?? '').replace(/[^\w.-]+/g, '_').slice(0, 64) || 'unknown'

/**
 * The bridge as the plugin's client expects it, over one document.
 * @param {{ document?: Document, randomId?: () => string }} [options]
 */
export function createBrowserBridge({ document: doc, randomId = () => Math.random().toString(36).slice(2) } = {}) {
  /** @type {Map<string, (url: string) => void>} */
  const listeners = new Map()
  let serial = 0

  // A guest that asks for a new window: the event is dispatched on its `<webview>`
  // element, so the document hears it in the capture phase whatever the element does
  // with it. The lease the element carries says which Bot asked. (The target is checked
  // by shape, not `instanceof Element`, so this module runs under Node tests too.)
  const hear = (event) => {
    const target = event.target
    const lease = target != null && typeof target.getAttribute === 'function' ? target.getAttribute('name') : null
    const listener = lease === null ? undefined : listeners.get(lease)
    if (listener === undefined) return
    event.preventDefault()
    listener(String(event.url ?? ''))
  }
  if (doc !== undefined) doc.addEventListener('new-window', hear, true)

  return {
    protocolVersion: 1,
    browser: {
      /**
       * One guest's lease and storage partition for `key` (the Bot's id).
       * @returns {Promise<{lease: string, partition: string}>}
       */
      async acquire(key) {
        return { lease: `lease-${++serial}-${randomId()}`, partition: `${PARTITION_PREFIX}${safeKey(key)}` }
      },
      /** A guest goes away with its element; nothing is left to release. */
      async release() {},
      /**
       * Hear the pages this lease's guest asks to open. The page turns each one into a
       * new tab of the same Bot.
       * @returns {() => void} stops listening
       */
      onOpenRequested(lease, listener) {
        listeners.set(String(lease), listener)
        return () => listeners.delete(String(lease))
      },
    },
  }
}

/**
 * Give a window of the desktop app the bridge when no shell gave it one. The app's
 * preload marks its window with `dsBotApp` in both of its front ends; a `dshDesktop`
 * that already exists (DSH Desktop) is never replaced. The app's own update state rides
 * along: the preload provides it as `dsBotApp.updates`, and the update card reads it as
 * `dshDesktop.updates`.
 * @param {any} [scope] the window, for tests; the page's own `window` by default
 * @returns {any} the bridge that was installed, or undefined when this window gets none
 */
export function installOwnBrowserBridge(scope) {
  const w = scope ?? globalThis.window
  if (w === undefined || w.dshDesktop !== undefined || w.dsBotApp === undefined) return undefined
  w.dshDesktop = createBrowserBridge({ document: w.document })
  if (w.dsBotApp.updates !== undefined) w.dshDesktop.updates = w.dsBotApp.updates
  return w.dshDesktop
}

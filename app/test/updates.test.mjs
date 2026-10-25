import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { showsDshRow } from '../../ds-bot/src/client/dsh-offer.js'
import { isNewer, RELEASES_URL, watchReleases, watchUpdates } from '../src/updates.mjs'

// electron-updater's AppUpdater, as far as the app uses it. `found` makes the answer of a
// check that finds a version, with the download that autoDownload starts.
class FakeUpdater extends EventEmitter {
  checks = 0
  feeds = []
  installs = []
  failCheck = false
  found = null
  checkForUpdates() {
    this.checks += 1
    if (this.failCheck) {
      const error = new Error('offline')
      this.emit('error', error)
      return Promise.reject(error)
    }
    return Promise.resolve(this.found?.() ?? { isUpdateAvailable: false, updateInfo: { version: '0.1.7' } })
  }
  setFeedURL(options) { this.feeds.push(options) }
  quitAndInstall(...args) { this.installs.push(args) }
}

const finds = (version, download) => () => ({ isUpdateAvailable: true, updateInfo: { version }, downloadPromise: download() })

const quietLog = () => {
  const lines = []
  return { lines, info: (line) => { lines.push(line) }, error: (line) => { lines.push(line) } }
}

const release = (version, options = {}) => {
  const arch = options.arch ?? 'arm64'
  return {
    tag_name: `v${version}`,
    html_url: options.page ?? `https://github.com/Miasakiii/DeepSeek-Bot/releases/tag/v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: options.assets ?? [{ name: `DeepSeek-Bot-${version}-mac-${arch}.zip` }],
  }
}

const releaseResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('isNewer', () => {
  for (const [candidate, current, expected] of [
    ['0.1.8', '0.1.7', true],
    ['v0.2.0', '0.1.9', true],
    ['0.1.7', '0.1.7', false],
    ['0.1.6', '0.1.7', false],
    ['0.2.0', '0.2.0-rc.2', true],
    ['0.2.0-rc.2', '0.2.0', false],
    ['0.2.0-rc.10', '0.2.0-rc.2', true],
    ['0.1.10', '0.1.9', true],
    ['nightly', '0.1.7', false],
  ]) {
    test(`${candidate} compared with ${current}`, () => {
      assert.equal(isNewer(candidate, current), expected)
    })
  }
})

describe('watchReleases', () => {
  test('checks the latest release at once with the GitHub headers, or uses a given feed', async (t) => {
    const calls = []
    const fetch = async (url, options) => {
      calls.push({ url, options })
      return releaseResponse([release('0.1.7')])
    }
    const updates = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, log: quietLog() })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
    assert.deepEqual(calls[0], {
      url: RELEASES_URL,
      options: { headers: { accept: 'application/vnd.github+json', 'user-agent': 'DeepSeek-Bot/0.1.7' } },
    })

    const feed = 'http://127.0.0.1:8080/'
    const custom = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, feed, log: quietLog() })
    t.after(custom.stop)
    await custom.latest()
    assert.equal(calls[1].url, feed)
  })

  test('reports a newer release and opens its page only when accepted', async (t) => {
    const page = 'https://github.com/Miasakiii/DeepSeek-Bot/releases/tag/v0.1.9'
    for (const accepted of [true, false]) {
      const asked = []
      const opened = []
      const updates = watchReleases({
        current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9', { page })]), log: quietLog(),
        ask: async version => { asked.push(version); return accepted },
        open: url => { opened.push(url) },
      })
      t.after(updates.stop)
      assert.deepEqual(await updates.latest(), { version: '0.1.9', page })
      await sleep(0)
      assert.deepEqual(asked, ['0.1.9'])
      assert.deepEqual(opened, accepted ? [page] : [])
    }
  })

  test('ignores the same or an older release', async (t) => {
    for (const version of ['0.1.7', '0.1.6']) {
      const asked = []
      const updates = watchReleases({
        current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release(version)]), log: quietLog(),
        ask: async value => { asked.push(value); return true }, open: () => {},
      })
      t.after(updates.stop)
      assert.equal(await updates.latest(), null)
      assert.deepEqual(asked, [])
    }
  })

  test('asks once per version and asks again for a later version', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let version = '0.1.9'
    let checks = 0
    const asked = []
    const updates = watchReleases({
      current: '0.1.7',
      arch: 'arm64',
      fetch: async () => { checks += 1; return releaseResponse([release(version)]) },
      ask: async value => { asked.push(value); return false },
      open: () => {},
      log: quietLog(),
    })
    t.after(updates.stop)

    await updates.latest()
    await sleep(0)
    t.mock.timers.tick(4 * 60 * 60_000)
    await updates.latest()
    await sleep(0)
    version = '0.1.10'
    t.mock.timers.tick(4 * 60 * 60_000)
    await updates.latest()
    await sleep(0)

    assert.equal(checks, 3)
    assert.deepEqual(asked, ['0.1.9', '0.1.10'])
  })

  test('reports releases without asking in throwaway runs', async (t) => {
    let opens = 0
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9')]),
      ask: undefined, open: () => { opens += 1 }, log: quietLog(),
    })
    t.after(updates.stop)
    assert.equal((await updates.latest()).version, '0.1.9')
    assert.equal(opens, 0)
  })

  test('logs failed requests, invalid JSON, and non-HTTPS release pages without throwing', async (t) => {
    const cases = [
      [async () => releaseResponse({}, 403), 'DeepSeek Bot: update check failed: HTTP 403'],
      [async () => { throw new Error('offline') }, 'DeepSeek Bot: update check failed: offline'],
      [async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON') } }), 'DeepSeek Bot: update check failed: bad JSON'],
      [async () => releaseResponse([release('0.1.9', { page: 'http://github.com/Miasakiii/DeepSeek-Bot' })]), 'DeepSeek Bot: update check failed: release page URL is not HTTPS'],
    ]
    for (const [fetch, message] of cases) {
      const log = quietLog()
      const updates = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, log })
      t.after(updates.stop)
      assert.equal(await updates.latest(), null)
      assert.deepEqual(log.lines, [message])
    }
  })

  test('logs a non-array release response once', async (t) => {
    const log = quietLog()
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse({ releases: [] }), log,
    })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
    assert.deepEqual(log.lines, ['DeepSeek Bot: update check failed: releases response is not an array'])
  })

  test('waits for the matching-architecture zip before asking', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let attached = false
    const asked = []
    const updates = watchReleases({
      current: '0.1.7',
      arch: 'arm64',
      fetch: async () => releaseResponse([release('0.1.9', { arch: attached ? 'arm64' : 'x64' })]),
      ask: async version => { asked.push(version); return false },
      open: () => {},
      log: quietLog(),
    })
    t.after(updates.stop)

    assert.equal(await updates.latest(), null)
    await sleep(0)
    assert.deepEqual(asked, [])
    attached = true
    t.mock.timers.tick(4 * 60 * 60_000)
    assert.deepEqual(await updates.latest(), {
      version: '0.1.9', page: 'https://github.com/Miasakiii/DeepSeek-Bot/releases/tag/v0.1.9',
    })
    await sleep(0)
    assert.deepEqual(asked, ['0.1.9'])
  })

  test('ignores prereleases for a stable installation', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.2.0-rc.2', { prerelease: true })]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
  })

  test('includes prereleases when the installed version is a prerelease', async (t) => {
    const updates = watchReleases({
      current: '0.2.0-rc.1', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.2.0-rc.2', { prerelease: true })]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.deepEqual(await updates.latest(), {
      version: '0.2.0-rc.2', page: 'https://github.com/Miasakiii/DeepSeek-Bot/releases/tag/v0.2.0-rc.2',
    })
  })

  test('ignores draft releases', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.1.9', { draft: true })]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
  })

  test('chooses the highest newer release with a matching zip', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.1.9'), release('0.1.10'), release('0.1.8')]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.deepEqual(await updates.latest(), {
      version: '0.1.10', page: 'https://github.com/Miasakiii/DeepSeek-Bot/releases/tag/v0.1.10',
    })
  })

  test('logs a rejected prompt without an unhandled rejection', async (t) => {
    const unhandled = []
    const note = error => { unhandled.push(error) }
    process.on('unhandledRejection', note)
    t.after(() => { process.off('unhandledRejection', note) })
    const log = quietLog()
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9')]),
      ask: async () => { throw new Error('dialog failed') }, open: () => {}, log,
    })
    t.after(updates.stop)
    await updates.latest()
    await sleep(20)
    assert.deepEqual(log.lines, ['DeepSeek Bot: update 0.1.9 available', 'DeepSeek Bot: update 0.1.9 not opened: dialog failed'])
    assert.deepEqual(unhandled, [])
  })

  test('tells the found release, keeps it through a failed later check, and drops it when a check finds none', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let answer = '0.1.9'
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => {
        if (answer === 'fail') throw new Error('offline')
        return releaseResponse([release(answer)])
      },
      log: quietLog(),
    })
    t.after(updates.stop)
    await updates.latest()
    assert.deepEqual(await updates.status(), { phase: 'available', version: '0.1.9' })
    answer = 'fail'
    t.mock.timers.tick(4 * 60 * 60_000)
    await updates.latest()
    assert.deepEqual(await updates.status(), { phase: 'available', version: '0.1.9' })
    answer = '0.1.7'
    t.mock.timers.tick(4 * 60 * 60_000)
    await updates.latest()
    assert.deepEqual(await updates.status(), { phase: 'idle', version: null })
  })

  test('without a newer release there is nothing to tell', async (t) => {
    const updates = watchReleases({ current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.7')]), log: quietLog() })
    t.after(updates.stop)
    await updates.latest()
    assert.deepEqual(await updates.status(), { phase: 'idle', version: null })
  })

  test('stop clears the interval', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let checks = 0
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => { checks += 1; return releaseResponse([release('0.1.7')]) }, log: quietLog(),
    })
    await updates.latest()
    updates.stop()
    t.mock.timers.tick(4 * 60 * 60_000)
    assert.equal(checks, 1)
  })
})

describe('watchUpdates', () => {
  test('downloads in the background, installs at the quit, and checks at once', (t) => {
    const updater = new FakeUpdater()
    t.after(watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() }).stop)
    assert.equal(updater.autoDownload, true)
    assert.equal(updater.autoInstallOnAppQuit, true)
    assert.equal(updater.checks, 1)
    assert.deepEqual(updater.feeds, [])
  })

  test('reads a given feed in place of the GitHub releases', (t) => {
    const updater = new FakeUpdater()
    t.after(watchUpdates({ updater, beforeInstall: async () => {}, feed: 'http://127.0.0.1:8080/', log: quietLog() }).stop)
    assert.deepEqual(updater.feeds, [{ provider: 'generic', url: 'http://127.0.0.1:8080/' }])
  })

  test('asks once per downloaded version, and on restart stops the Host before the installer runs', async (t) => {
    const updater = new FakeUpdater()
    const steps = []
    const asked = []
    t.after(watchUpdates({
      updater, log: quietLog(),
      ask: async (version) => { asked.push(version); return true },
      beforeInstall: async () => { await sleep(10); steps.push('host stopped') },
    }).stop)
    updater.quitAndInstall = (...args) => { steps.push(['install', ...args]) }
    updater.emit('update-downloaded', { version: '0.1.9' })
    updater.emit('update-downloaded', { version: '0.1.9' })
    await sleep(50)
    assert.deepEqual(asked, ['0.1.9'])
    assert.deepEqual(steps, ['host stopped', ['install', true, true]])
  })

  test('leaves the update for the next quit when the user says later, or when it may not ask', async (t) => {
    for (const ask of [async () => false, undefined]) {
      const updater = new FakeUpdater()
      const log = quietLog()
      let stopped = false
      t.after(watchUpdates({ updater, ask, log, beforeInstall: async () => { stopped = true } }).stop)
      updater.emit('update-downloaded', { version: '0.1.9' })
      await sleep(20)
      assert.deepEqual(updater.installs, [])
      assert.equal(stopped, false)
      assert.deepEqual(log.lines, ['DeepSeek Bot: update 0.1.9 downloaded'])
    }
  })

  test('logs a failed check and does not throw', async (t) => {
    const updater = new FakeUpdater()
    updater.failCheck = true
    const log = quietLog()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
    assert.deepEqual(log.lines, ['DeepSeek Bot: update failed: offline'])
  })

  test('tells what the newest check found and whether its download finished', async (t) => {
    const cases = [
      [null, null],
      [finds('0.1.9', () => Promise.resolve(['installer.exe'])), true],
      [finds('0.1.9', () => Promise.reject(new Error('sha512 checksum mismatch'))), false],
    ]
    for (const [found, downloaded] of cases) {
      const updater = new FakeUpdater()
      updater.found = found
      const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
      t.after(updates.stop)
      const latest = await updates.latest()
      if (downloaded === null) assert.equal(latest, null)
      else {
        assert.equal(latest.version, '0.1.9')
        assert.equal(await latest.downloaded, downloaded)
      }
    }
  })

  test('a failed download, which electron-updater also reports as an error, is not left unhandled', async (t) => {
    const unhandled = []
    const note = (error) => { unhandled.push(error) }
    process.on('unhandledRejection', note)
    t.after(() => { process.off('unhandledRejection', note) })
    const updater = new FakeUpdater()
    updater.found = finds('0.1.9', () => Promise.reject(new Error('sha512 checksum mismatch')))
    t.after(watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() }).stop)
    await sleep(20)
    assert.deepEqual(unhandled, [])
  })

  test('installs on request: the Host stops first, then the installer runs and opens the app again', async (t) => {
    const updater = new FakeUpdater()
    const steps = []
    const updates = watchUpdates({ updater, beforeInstall: async () => { steps.push('host stopped') }, log: quietLog() })
    t.after(updates.stop)
    updater.quitAndInstall = (...args) => { steps.push(['install', ...args]) }
    await updates.install()
    assert.deepEqual(steps, ['host stopped', ['install', true, true]])
  })

  test('checks again every few hours until stopped', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const updater = new FakeUpdater()
    const { stop } = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.mock.timers.tick(4 * 60 * 60_000)
    assert.equal(updater.checks, 2)
    stop()
    t.mock.timers.tick(8 * 60 * 60_000)
    assert.equal(updater.checks, 2)
  })

  test('tells each stage to its subscribers, and status answers the newest snapshot', async (t) => {
    const updater = new FakeUpdater()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    const heard = []
    const stop = updates.subscribe(status => heard.push(status))
    // Subscribing tells nothing by itself: the page asks for the snapshot first.
    assert.deepEqual(heard, [])
    assert.deepEqual(await updates.status(), { phase: 'idle', version: null })
    updater.emit('update-available', { version: '0.1.9' })
    updater.emit('download-progress', { percent: 41 })
    updater.emit('update-downloaded', { version: '0.1.9' })
    assert.deepEqual(heard, [
      { phase: 'available', version: '0.1.9' },
      { phase: 'downloading', version: '0.1.9' },
      { phase: 'ready', version: '0.1.9' },
    ])
    // The same state again changes nothing; another listener's answer does not either.
    updater.emit('update-downloaded', { version: '0.1.9' })
    assert.deepEqual(heard.length, 3)
    stop()
    // A failed check or download leaves the snapshot honest, but tells nobody who left.
    updater.emit('error', new Error('offline'))
    assert.deepEqual(heard.length, 3)
    assert.deepEqual(await updates.status(), { phase: 'error', version: '0.1.9' })
    // A check that finds nothing retires what an earlier one found.
    updater.emit('update-not-available')
    assert.deepEqual(await updates.status(), { phase: 'idle', version: null })
  })

  test('the snapshot is the shape the plugin update card matches against', async (t) => {
    const updater = new FakeUpdater()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    updater.emit('update-downloaded', { version: '0.2.1-alpha.1' })
    const dsh = { kind: 'app', verified: '0.2.1-alpha.1', current: '0.2.0-rc.2' }
    assert.equal(showsDshRow(dsh, await updates.status()), true)
    assert.equal(showsDshRow({ ...dsh, verified: '9.9.9' }, await updates.status()), false)
    assert.equal(showsDshRow(dsh, undefined), false)
  })
})

// The window reads the app's update state through the preload's `dsBotApp.updates`, which
// the main process answers and pushes over these channels; the two sides must agree on
// their names, which no import between them checks (main.mjs's IPC table, preload strings).
test('the main process and the preload name the same updates channels', () => {
  const main = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8')
  for (const channel of ['ds-bot:updates-status', 'ds-bot:updates-changed']) {
    assert.ok(main.includes(channel), `main.mjs does not name ${channel}`)
    assert.ok(preload.includes(channel), `preload.cjs does not name ${channel}`)
  }
})

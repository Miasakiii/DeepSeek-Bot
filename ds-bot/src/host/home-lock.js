// One writer per plugin home. dsh Web and dsh Desktop share ~/.dsh, and each host keeps
// the team in memory and writes state.json whole, so two hosts at once would undo each
// other's changes. The first host to load takes `state.lock`; a second one only reads.
//
// The lock is a small JSON file (pid, host, a random token) whose mtime the holder bumps
// on a timer. On the same host, its process decides whether it is live; `staleMs` only
// covers other hosts and unreadable files. A reused pid after a crash keeps the second
// host read-only until that process ends. The token, not the pid, decides ownership: a
// holder that finds another token has lost the lock.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

// Whether a lock file's holder still holds it: its process on this host, else a fresh
// mtime. `holder` is what `homeLock(path).read()` answers: undefined for no file, null
// for one that does not parse (being written right now).
export function holderLive(holder, path, { staleMs = 60_000, host = hostname(), pid = process.pid, isAlive = pidAlive, now = Date.now } = {}) {
  if (holder === undefined) return false
  const fresh = () => {
    try { return now() - statSync(path).mtimeMs < staleMs } catch { return false }
  }
  if (holder === null) return fresh()
  if (holder.host === host) return holder.pid !== pid && isAlive(holder.pid)
  return fresh()
}

export function homeLock(path, { staleMs = 60_000, beatMs = 15_000, host = hostname(), pid = process.pid, isAlive = pidAlive, now = Date.now } = {}) {
  const token = randomUUID()
  let timer

  // undefined: no lock file; null: a file that does not parse (being written right now).
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return error?.code === 'ENOENT' ? undefined : null
    }
  }
  const live = holder => holderLive(holder, path, { staleMs, host, pid, isAlive, now })
  const owns = () => read()?.token === token

  const beat = () => {
    if (!owns()) {
      stop()
      return
    }
    const time = new Date(now())
    try { utimesSync(path, time, time) } catch {}
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  // Take the lock if it is free or its holder is gone. Returns undefined when this
  // process holds it, else what the lock file says about the holder.
  function claim() {
    if (owns()) return undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ pid, host, token, since: now() }), { flag: 'wx' })
        stop()
        timer = setInterval(beat, beatMs)
        timer.unref?.()
        return undefined
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const holder = read()
      if (live(holder)) return holder ?? {}
      const current = read()
      const unchanged = holder === null
        ? current === null
        : holder?.token !== undefined
          ? current?.token === holder.token
          : JSON.stringify(current) === JSON.stringify(holder)
      if (unchanged) {
        try { unlinkSync(path) } catch {}
      }
    }
    return read() ?? {}
  }

  function release() {
    stop()
    if (owns()) {
      try { unlinkSync(path) } catch {}
    }
  }

  return { claim, owns, release, read }
}

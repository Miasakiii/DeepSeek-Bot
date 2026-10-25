// The DeepSeek sign-in of a window that rides no shell of its own (the desktop app's
// own window): the host starts DSH's browser authorization and this dialog follows its
// attempt. The authorize page opens in the system browser — the app shell sends
// window.open there — and the loopback callback lands on the engine's own web server,
// which finishes the login without this window taking part.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SPRING_SHAPE } from './motion.js'
import { hostText, language, t } from './i18n.js'
import { useEscape } from './overlay-hooks.js'

// The phases whose next move is the browser or the host, not this dialog.
const LIVE = new Set(['initializing', 'waiting-browser', 'exchanging', 'committing'])
const POLL_MS = 2000

export function OwnSignInDialog({ open, actions, leaving }) {
  if (!open || !actions.ownSignIn) return null
  return createPortal(h(SignIn, { key: open, actions, leaving }), document.body)
}

function SignIn({ actions, leaving }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [run, setRun] = useState(0)
  const started = useRef(0)
  const close = () => actions.closeSignIn()
  useEscape(close)
  // Each run starts a fresh attempt on the host; a slow earlier answer never lands.
  useEffect(() => {
    const mine = ++started.current
    setView(null)
    setError('')
    void Promise.resolve(actions.accountStart({ locale: language(), timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }))
      .then((state) => { if (mine === started.current) setView(state) },
        (failure) => { if (mine === started.current) setError(failure?.message ?? String(failure)) })
  }, [run])
  const attempt = view?.attempt ?? null
  // While the attempt runs, follow its phases: the exchange and the commit happen in
  // the callback the system browser hits, so only the host sees them move.
  useEffect(() => {
    if (attempt === null || !LIVE.has(attempt.phase)) return undefined
    const timer = setInterval(() => {
      void Promise.resolve(actions.accountState?.()).then((answer) => {
        if (answer?.state !== undefined && answer.state !== null) setView(answer.state)
      }, () => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [attempt?.id, attempt?.phase])
  // A finished sign-in closes on its own; the feed's account news then refreshes the
  // models with it.
  useEffect(() => {
    if (attempt?.phase !== 'succeeded' && view?.status !== 'credential-stored') return undefined
    const timer = setTimeout(close, 700)
    return () => clearTimeout(timer)
  }, [attempt?.phase, view?.status])
  const cancel = () => {
    if (attempt?.id !== undefined) void Promise.resolve(actions.accountCancel?.(attempt.id)).catch(() => {})
    close()
  }
  const copy = () => {
    void navigator.clipboard?.writeText(attempt?.authorizeUrl ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  const minutes = Number.isFinite(attempt?.expiresAt) ? Math.max(0, Math.ceil((attempt.expiresAt - Date.now()) / 60000)) : undefined
  const phase = attempt?.phase
  const line = error !== '' ? hostText(error)
    : view === null ? t('Starting the DeepSeek sign-in…')
    : phase === 'waiting-browser' ? t('Finish the sign-in in your browser. You can copy the link if it does not open.')
    : phase === 'exchanging' || phase === 'committing' ? t('Finishing the sign-in…')
    : phase === 'succeeded' ? t('Signed in.')
    : phase === 'cancelled' ? t('The sign-in was cancelled.')
    : phase === 'expired' ? t('The sign-in page expired.')
    : phase === 'failed' ? t('The sign-in failed.')
    : t('Starting the DeepSeek sign-in…')
  return h('div', { className: 'bt-account-layer', 'data-leaving': leaving || undefined },
    // Dismissing only: the attempt goes on without the dialog, and a reopened sign-in
    // joins it (the service's startSignIn joins a live attempt), so a stray click
    // outside never kills the authorization waiting in the browser. Cancelling is the
    // Cancel button's job.
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-account-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Sign in to DeepSeek') },
      h('h2', { className: 'bt-account-title' }, t('Sign in to DeepSeek')),
      h('p', { className: 'bt-account-line', 'data-error': error !== '' || undefined }, line),
      minutes !== undefined && phase === 'waiting-browser' && minutes > 0
        ? h('p', { className: 'bt-account-hint' }, t('The link stops working in {minutes} minutes.', { minutes })) : null,
      phase === 'waiting-browser' && attempt.authorizeUrl ? h('div', { className: 'bt-account-row' },
        h('a', {
          className: 'bt-account-open', href: attempt.authorizeUrl, target: '_blank', rel: 'noopener noreferrer',
        }, t('Open sign-in page')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, copied ? t('Copied') : t('Copy link'))) : null,
      h('div', { className: 'bt-account-row' },
        error !== '' || phase === 'failed' || phase === 'expired' || phase === 'cancelled'
          ? h('button', { type: 'button', className: 'bt-soft', onClick: () => setRun(value => value + 1) }, t('Try again')) : null,
        attempt !== null && LIVE.has(phase) ? h('button', { type: 'button', className: 'bt-soft', onClick: cancel }, t('Cancel')) : null,
        h('button', { type: 'button', className: 'bt-account-close', onClick: close }, t('Close')))))
}

// The layer sits at a plain integer: the own window defines --dsh-frame-overlay-top as
// a length (app.css), and calc() over a length is invalid for z-index — it computes to
// auto and the dialog sinks under the settings one. 80 is above the settings (60),
// memory (61) and palette (70) dialogs this sign-in opens from, below the toast (1000).
export const ACCOUNT_CSS = `
.bt-account-layer{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:24px}
.bt-account-dialog{width:min(400px,100%);display:flex;flex-direction:column;gap:10px;padding:20px;border-radius:16px;border:.5px solid var(--bt-line-2);background:var(--bt-card);color:var(--bt-ink);box-shadow:0 24px 80px rgba(0,0,0,.24);animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-account-title{margin:0;font-size:15px;line-height:20px;font-weight:600}
.bt-account-line{margin:0;font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-account-line[data-error]{color:var(--bt-danger)}
.bt-account-hint{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-account-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-account-open{display:inline-flex;align-items:center;min-height:30px;padding:6px 14px;border-radius:8px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:13px;line-height:18px;text-decoration:none;cursor:pointer}
.bt-account-open:hover{filter:brightness(1.06)}
.bt-account-open:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-account-close{margin-left:auto}
.bt-account-layer[data-leaving]{pointer-events:none}
.bt-account-layer[data-leaving] .bt-scrim{opacity:0;transition:opacity .16s ease-in}
.bt-account-layer[data-leaving] .bt-account-dialog{animation:bt-dialog-sink .16s cubic-bezier(.4,0,1,1) forwards}
@media (prefers-reduced-motion:reduce){.bt-account-dialog,.bt-account-layer .bt-scrim{animation:bt-fade .12s ease-out!important}}
`

import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { adoptToken } from './api.js'
import { installOwnBrowserBridge } from '../../../ds-bot/src/client/browser-bridge.js'
import { ABOUT_CSS } from '../../../ds-bot/src/client/about.js'
import { ACCOUNT_CSS } from '../../../ds-bot/src/client/account-dialog.js'
import { BOT_SETTINGS_CSS } from '../../../ds-bot/src/client/bot-settings.js'
import { FEEDBACK_CSS } from '../../../ds-bot/src/client/feedback.js'
import { FOLDER_CSS } from '../../../ds-bot/src/client/folder-menu.js'
import { GROUP_SETTINGS_CSS } from '../../../ds-bot/src/client/group-settings.js'
import { installLocale } from '../../../ds-bot/src/client/i18n.js'
import { MEMBER_CSS } from '../../../ds-bot/src/client/member-status.js'
import { MODEL_CSS } from '../../../ds-bot/src/client/model-menu.js'
import { PROVIDERS_CSS } from '../../../ds-bot/src/client/providers-page.js'
import { SCHEDULE_CSS } from '../../../ds-bot/src/client/schedules.js'
import { SECRET_CSS } from '../../../ds-bot/src/client/secret-card.js'
import { SIDEBAR_CSS } from '../../../ds-bot/src/client/sidebar.js'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../ds-bot/src/client/styles.js'
import { USAGE_CSS } from '../../../ds-bot/src/client/usage-page.js'
import { WIDGET_CSS } from '../../../ds-bot/src/client/widget-cell.js'
import { createLocale } from './locale.js'
import { App } from './app.js'
import './app.css'

installLocale(createLocale(navigator.language))
document.documentElement.lang = navigator.language
// The outlet's token, before anything talks to it: it leaves the address bar at once.
adoptToken()
// The window's own webview bridge for the Bot browsers, when no shell gave the page one.
installOwnBrowserBridge(window)
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
for (const [tag, text] of [
  ['shell', SHELL_CSS], ['sidebar', SIDEBAR_CSS], ['conversation', CONVERSATION_CSS], ['secrets', SECRET_CSS], ['providers', PROVIDERS_CSS + ACCOUNT_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS], ['usage', USAGE_CSS], ['schedules', SCHEDULE_CSS],
  ['feedback', FEEDBACK_CSS], ['about', ABOUT_CSS], ['members', MEMBER_CSS], ['widgets', WIDGET_CSS],
]) installStyles(text, tag)

// The plugin's colors switch on body[data-ds-dark-theme], which DSH sets; here the system's
// light or dark mode sets it.
const dark = matchMedia('(prefers-color-scheme: dark)')
const paint = () => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
paint()
dark.addEventListener('change', paint)

createRoot(document.getElementById('root')).render(h(App))

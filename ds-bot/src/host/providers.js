// Model providers and their API keys, for a window that has no DSH Models page of its
// own. Two sides hold the routes: the own directory (state.providers, served by the own
// adapter in llm.js) holds the ones this plugin serves — a custom endpoint, its key in
// the vault — and DSH's own settings hold the ones its adapters serve, a route's key in
// DSH's credential store. The Models page lists both; a route is written on the side
// that owns it.

import { discoverWireModels } from './llm.js'

const PI_AI = 'llm-pi-ai'
// The wire protocols DSH's pi-ai adapter serves on a route it ships nothing about.
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const MAX_MODELS = 500

// The reference DSH's own Models page derives for a route's key, so a provider added
// here and one added there read the same key.
export const keyRefFor = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What an HTTP header can carry, like DSH's own key check: a pasted `NAME=value` line
// or a quoted value would be stored as the key and refused by the provider.
export function checkKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key === '') throw invalid('Enter the API key')
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^=]/.test(key)) throw invalid('Paste only the key, not a NAME=value line')
  if (/^(["']).*\1$/.test(key)) throw invalid('Paste the key without quotes')
  if (!/^[\x21-\x7E]+$/.test(key)) throw invalid('An API key has no spaces or special characters')
  return key
}

function checkEndpoint(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address')
  return text
}

// A model as the route stores it: what discovery told about it, under pi-ai's names.
function modelEntry(model) {
  const id = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : ''
  if (id === '') throw invalid('Every model needs an id')
  const whole = value => (Number.isInteger(value) && value > 0 ? value : undefined)
  return {
    id,
    ...(typeof model?.name === 'string' && model.name.trim() !== '' ? { name: model.name.trim() } : {}),
    ...(whole(model?.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(whole(model?.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    ...(Array.isArray(model?.inputModalities) && model.inputModalities.length > 0 ? { input: model.inputModalities.filter(kind => typeof kind === 'string') } : {}),
  }
}

export function install(rt) {
  const { ctx, state } = rt

  const seams = () => {
    const settings = ctx.get?.('settings')
    const credentials = ctx.get?.('credentials')
    return settings && credentials && ctx.llm.listConfigurableProviders ? { settings, credentials } : undefined
  }
  const usable = () => {
    const found = seams()
    if (found === undefined) throw invalid('This DSH cannot set up model providers')
    return found
  }
  const sections = settings => new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
  const profileOf = (entry, map, layer = 'value') => entry.settingsPath.reduce((value, key) => value?.[key], map.get(entry.settingsNs)?.[layer])
  const refOf = profile => (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined)
  const entryOf = provider => ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
  const ownOf = provider => rt.ownProviders().find(entry => entry.id === provider)

  // Per provider route, the credential its DSH settings name as its API key. A
  // provider with none authenticates some other way.
  function keyRefs() {
    const found = seams()
    if (found === undefined) return new Map()
    const map = sections(found.settings)
    const refs = new Map()
    for (const entry of ctx.llm.listConfigurableProviders()) {
      const ref = refOf(profileOf(entry, map))
      if (ref !== undefined) refs.set(entry.provider, ref)
    }
    return refs
  }

  // An own route's key state: the vault holds it, or the environment names it under the
  // same reference. Both sides are this plugin's own, so the key is always writable.
  async function ownKeyState(entry) {
    const refs = new Set(await rt.ownKeyVault.refs().catch(() => []))
    const fromEnv = process.env[entry.keyRef]
    return { configured: refs.has(entry.keyRef) || (typeof fromEnv === 'string' && fromEnv !== ''), writable: true }
  }

  async function missingKeys(providers) {
    const missing = new Set()
    const vaultRefs = new Set(await rt.ownKeyVault.refs().catch(() => []))
    for (const id of providers) {
      const own = ownOf(id)
      if (own === undefined) continue
      if (!vaultRefs.has(own.keyRef) && !(process.env[own.keyRef] ?? '')) missing.add(id)
    }
    let refs
    try { refs = keyRefs() } catch { return missing }
    await Promise.all(providers.filter(id => refs.has(id)).map(async (id) => {
      const info = await seams().credentials.describe(refs.get(id)).catch(() => undefined)
      if (info?.configured === false) missing.add(id)
    }))
    return missing
  }

  // The own directory's routes, then the ones DSH serves, with their models and key
  // state. A provider with no key and no models (DeepSeek's account route before a
  // sign-in) is left out.
  async function providersView() {
    const catalog = await rt.catalog({ fresh: true })
    const found = seams()
    const providers = []
    const addable = []
    for (const entry of rt.ownProviders()) {
      const models = catalog.filter(model => model.provider === entry.id).map(model => ({ ref: model.ref, name: model.name }))
      providers.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        models,
        key: await ownKeyState(entry),
        removable: true,
        custom: true,
      })
    }
    if (found !== undefined) {
      const map = sections(found.settings)
      for (const entry of ctx.llm.listConfigurableProviders()) {
        const profile = profileOf(entry, map)
        if (entry.settingsNs === PI_AI && profile === undefined) {
          if (entry.declared !== true) addable.push({ id: entry.provider, name: entry.displayName })
          continue
        }
        const ref = refOf(profile)
        const models = catalog.filter(model => model.provider === entry.provider).map(model => ({ ref: model.ref, name: model.name }))
        if (ref === undefined && models.length === 0 && entry.error === undefined) continue
        const info = ref === undefined ? undefined : await found.credentials.describe(ref).catch(() => undefined)
        providers.push({
          id: entry.provider,
          name: entry.displayName,
          models,
          key: ref === undefined ? null : { configured: info?.configured === true, writable: info?.writable !== false },
          removable: entry.settingsNs === PI_AI && profileOf(entry, map, 'user') !== undefined && profileOf(entry, map, 'base') === undefined,
          custom: entry.declared === true,
          ...(entry.error ? { error: entry.error } : {}),
        })
      }
    }
    // The ones that come with the setup first, then the added ones as DSH lists them.
    providers.sort((a, b) => Number(a.removable) - Number(b.removable))
    return { available: providers.length > 0 || addable.length > 0 || found !== undefined, providers, addable, protocols: PROTOCOLS }
  }

  // A key is only ever written; nothing here reads one back. An own route's key goes to
  // the vault, a DSH route's to its credential store.
  async function setProviderKey(provider, value) {
    const key = checkKey(value)
    const own = ownOf(provider)
    if (own !== undefined) {
      await rt.ownKeyVault.set(own.keyRef, key)
      rt.dropCatalog()
      return
    }
    await usable().credentials.set(await writableRef(provider), key)
    rt.dropCatalog()
  }

  async function clearProviderKey(provider) {
    const own = ownOf(provider)
    if (own !== undefined) {
      await rt.ownKeyVault.remove(own.keyRef)
      rt.dropCatalog()
      return
    }
    await usable().credentials.unset(await writableRef(provider))
    rt.dropCatalog()
  }

  async function writableRef(provider) {
    const ref = keyRefs().get(provider)
    if (ref === undefined) throw invalid(`${provider} takes no API key here`)
    if ((await usable().credentials.describe(ref)).writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
    return ref
  }

  // `provider` from DSH's directory, or a route this plugin serves itself (`custom`)
  // for an endpoint DSH ships nothing about. The route goes in first, then its key, as
  // DSH's own Models page does it: a failed key write leaves a provider that asks for
  // one.
  async function addProvider(body) {
    const provider = String(body.provider ?? '').trim()
    const custom = body.custom === true
    const entry = entryOf(provider)
    if (ownOf(provider) !== undefined) throw invalid(`${provider} is already set up`)
    if (!custom && (entry === undefined || entry.declared === true)) throw invalid(`DSH offers no provider ${provider}`)
    if (custom && entry !== undefined) throw invalid(`DSH already offers ${provider}; add it from its list`)
    const key = typeof body.key === 'string' && body.key.trim() !== '' ? checkKey(body.key) : undefined
    if (custom) {
      if (!PROTOCOLS.includes(body.api)) throw invalid(`The protocol must be one of ${PROTOCOLS.join(', ')}`)
      const models = Array.isArray(body.models) ? body.models.slice(0, MAX_MODELS).map(modelEntry) : []
      if (models.length === 0) throw invalid('Add at least one model')
      if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id')
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
      await rt.setOwnProvider({
        id: provider,
        ...(name ? { name } : {}),
        protocol: body.api,
        baseURL: checkEndpoint(body.baseURL),
        models,
      }, key)
      rt.dropCatalog()
      return providersView()
    }
    const { settings, credentials } = usable()
    const map = sections(settings)
    if (entry !== undefined && (entry.settingsNs !== PI_AI || profileOf(entry, map) !== undefined)) throw invalid(`${provider} is already set up`)
    const ref = keyRefFor(provider)
    const info = await credentials.describe(ref)
    if (key !== undefined && info.writable === false) throw invalid(`The API key for ${provider} is set outside DS Bot and cannot be changed here`)
    // A blank key keeps a key that is already there, else the provider's own sign-in.
    const keyed = key !== undefined || info.configured === true
    const profile = {}
    if (keyed) profile.apiKeyEnv = ref
    await settings.mutate(PI_AI, [{ op: 'set', path: entry?.settingsPath ?? ['providers', provider], value: profile }], map.get(PI_AI)?.revision)
    if (key !== undefined) await credentials.set(ref, key)
    rt.dropCatalog()
    return providersView()
  }

  // The models an endpoint (or a provider DSH ships) says it serves. A custom draft is
  // asked over the own wire client, with the key typed for the question; the key goes
  // with it and is not stored.
  async function discoverModels(body) {
    const provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined
    const known = provider !== undefined && entryOf(provider)?.declared === false
    if (!known) {
      const key = typeof body.key === 'string' && body.key.trim() !== '' ? checkKey(body.key) : undefined
      const models = await discoverWireModels({
        protocol: PROTOCOLS.includes(body.api) ? body.api : 'openai-completions',
        baseURL: checkEndpoint(body.baseURL),
        ...(key === undefined ? {} : { apiKey: key }),
      })
      return models.slice(0, MAX_MODELS)
    }
    usable()
    const models = await ctx.llm.discoverModels(PI_AI, { provider })
    return models.slice(0, MAX_MODELS).map(model => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
    }))
  }

  // Only a route this plugin serves itself, or one a user added in DSH's settings, goes;
  // its key goes with it when it is the one this page derives and no other provider
  // names it.
  async function removeProvider(provider) {
    if (ownOf(provider) !== undefined) {
      await rt.removeOwnProvider(provider)
      rt.dropCatalog()
      return providersView()
    }
    const { settings, credentials } = usable()
    const map = sections(settings)
    const entry = entryOf(provider)
    if (entry === undefined || entry.settingsNs !== PI_AI || profileOf(entry, map) === undefined) throw invalid(`${provider} is not set up`)
    if (profileOf(entry, map, 'user') === undefined || profileOf(entry, map, 'base') !== undefined) throw invalid(`${provider} comes with this setup and cannot be removed`)
    const ref = refOf(profileOf(entry, map))
    const shared = [...keyRefs()].some(([other, otherRef]) => other !== provider && otherRef === ref)
    await settings.mutate(PI_AI, [{ op: 'unset', path: entry.settingsPath }], map.get(PI_AI)?.revision)
    if (ref === keyRefFor(provider) && !shared) {
      const info = await credentials.describe(ref)
      if (info.configured && info.writable) await credentials.unset(ref)
    }
    rt.dropCatalog()
    return providersView()
  }

  // First start after the provider side became this plugin's own: a route the user set
  // up in DSH's own settings — a custom endpoint with its protocol, models and key
  // reference — moves into the own directory, so this plugin serves it and DSH's
  // settings no longer hold it. A route DSH ships (its account routes, a catalog
  // provider's key row) stays where it is: the own directory serves what a user
  // declares. The key moves with the route — the credentials service resolves it once
  // and the vault seals it — and the settings row goes last, with the registration
  // following it, so one route is never served twice. Once only: a provider added
  // later stays on the side the user added it on.
  async function runMove() {
    if (state.providersMoved === true) return
    const found = seams()
    // A DSH without the settings seam has nothing to move; the next start tries again.
    if (found === undefined) return
    for (const entry of ctx.llm.listConfigurableProviders()) {
      // One row that cannot be read or written is named and left alone; the others move.
      try {
        await moveOne(entry, found)
      } catch (error) {
        rt.warn('ds-bot: the provider %s was not moved to the own directory: %s', entry.provider, error?.message ?? error)
      }
    }
    state.providersMoved = true
    await rt.save()
  }

  async function moveOne(entry, found) {
    const map = sections(found.settings)
    if (entry.settingsNs !== PI_AI) return
    const profile = profileOf(entry, map)
    if (profile === undefined || profileOf(entry, map, 'user') === undefined) return
    if (!PROTOCOLS.includes(profile.api) || typeof profile.baseURL !== 'string') return
    const models = Array.isArray(profile.models) ? profile.models.map(modelEntry) : []
    if (models.length === 0) return
    // A DSH whose credentials service cannot read a key back leaves the route where
    // its key works; every other row still moves.
    if (typeof found.credentials.resolve !== 'function') return
    // A route the own directory already holds stays as it is there.
    if (ownOf(entry.provider) !== undefined) return
    const ref = refOf(profile) ?? keyRefFor(entry.provider)
    const key = await found.credentials.resolve(ref).catch(() => undefined)
    await rt.setOwnProvider({
      id: entry.provider,
      ...(typeof profile.displayName === 'string' && profile.displayName !== '' ? { name: profile.displayName } : {}),
      protocol: profile.api,
      baseURL: profile.baseURL,
      keyRef: ref,
      models,
    }, key?.value)
    // DSH drops the route with its row; the registration takes it over on that
    // event (llm.js), so no route is served by two adapters.
    await found.settings.mutate(PI_AI, [{ op: 'unset', path: entry.settingsPath }], map.get(PI_AI)?.revision)
  }

  // One move at a time: the start-up effect and anything that asks for it share it.
  let moving = null
  const moveOwnProviders = () => (moving ??= runMove().finally(() => { moving = null }))

  ctx.effect(() => {
    void moveOwnProviders().catch(error => rt.warn('ds-bot: the providers were not moved to the own directory: %s', error))
    return () => {}
  }, 'ds-bot: move own providers')

  Object.assign(rt, { keyRefs, missingKeys, providersView, setProviderKey, clearProviderKey, addProvider, discoverModels, removeProvider, moveOwnProviders })
}

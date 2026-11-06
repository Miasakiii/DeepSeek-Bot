// C0.2 契约 fake（test/fake-host.js）——按 src/host/rt/host.js 的 HOST_CONTRACT 逐面供给语义
// 默认值，供 C0.3 的 L2 测试「只换供给不改断言」地迁移过来。fake 的每个行为都在注释里引用钉住
// 它的行为锁定测试（写法 dev/contract/<file>:<line>）；语义只以锁测试为准，锁不到位的标
// **未锁定** 并注原因，不照文档猜形状。
//
// 与 test/fake-ctx.js 的关系：本包**不 import 它**——fake-ctx.js 有 39 个测试文件在 import，
// 它的去留由 C0.3 的 L2 迁移决定；fake-host 是独立的第二条路。fake-ctx.js:54-58 明确不跑中间件、
// :60-68 只支持同步 disposer（execute 返回 Promise 时 disposer 丢失，effects.test.js:92-102 实证），
// 本包补的正是这两个缺口：事件面复刻真实 waterfall/emit 全链，effect 面支持异步 disposer。
//
// 纪律：不 import 任何 @deepseek-ai/*（scripts/check-dsh-imports.mjs 连 test/ 一起扫），
// 只用 node 内置模块与 src/host/rt/host.js 的纯数据索引。
import { HOST_CONTRACT } from '../src/host/rt/host.js'

export { HOST_CONTRACT }

// index.js:48 的八个硬注入服务与 §1.2 的 21 个可选服务，名字直接取契约索引，避免两份清单漂移。
const INJECTED_SERVICES = HOST_CONTRACT.injectedServices
const OPTIONAL_SERVICES = HOST_CONTRACT.optionalServices

// ============================================================================
// 0. 错误、谓词与小工具
// ============================================================================

// effects.test.js:174-178 与 tools-and-hidden.test.js:341-347：卸载后新建 effect / 注册监听报
// INACTIVE_EFFECT，消息是 "cannot create effect on inactive context"——注意是 **on** 不是 in，
// 所以 /in inactive context/ 捕不住它，parts.js:748 的谓词只能靠 uid === null 那一半。
const inactiveError = () => Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })

// tools-and-hidden.test.js:342/346：卸载后服务查找的消息带 "in inactive context" 字样，
// 谓词的正则半边归它。
const inactiveServiceError = name => new Error(`cannot get required service "${name}" in inactive context`)

// host.js §5 / parts.js:748 的等价谓词：宿主上下文（或 agent.ctx）卸载后对服务读取与新建贡献报错，
// 且 fiber.uid 已置 null。两个实现各自给出等价谓词，不复刻 cordis 内部。
export const isUnloaded = (ctx, error) => ctx?.fiber?.uid === null || /in inactive context/.test(String(error?.message ?? error))

// effects.test.js:38/50 在 disposer 上读 label 元数据（真实侧是 Context.effect 符号）。fake 不能
// import cordis 拿同一个符号，用自有的 EFFECT 符号承载同一形状，并额外挂一个 .label 便于读。
export const EFFECT = Symbol('ds-bot:fake-host:effect')

// 未被锁测试覆盖、且静默默认会「假装副作用发生过」的成员：调用即抛带名字的错误，测试经
// fakeHost({ services }) 显式配置。host.js §1.2 允许「未配置即抛」与「显式默认」二选一，
// 这一类选「抛」的理由：挂 MCP 客户端、开浏览器授权、装包、开目录选择器都是真实副作用，
// 假装修过会把迁移中的测试引向假绿。
const notConfigured = name => () => { throw new Error(`fake-host: "${name}" is not configured; pass it in fakeHost({ services })`) }

const deepClone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))

// session-objects.test.js:436-438：派生消息连 content 与 content 里的块都是冻结的。
const deepFreeze = value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const member of Object.values(value)) deepFreeze(member)
  return Object.freeze(value)
}

// ============================================================================
// 1. Fiber：uid 生命周期、effect 注册表与卸载
// ============================================================================

// 一个 effect 的登记 record。disposers 收集 body 交回的清理（可能经 Promise 或生成器晚到），
// settled 等 body 落定，task 是处置在途句柄（幂等二次调用拿回同一个）。
class EffectRecord {
  constructor(fiber, label) {
    this.fiber = fiber
    this.label = label
    this.disposers = []
    this.settled = Promise.resolve()
    this.pending = false
    this.state = 'live'
    this.task = null
  }
}

// body 的返回值分派：undefined/null 表示无需清理（effects.test.js:33/48-50），函数即 disposer，
// Promise<disposer> 兑现时收取（:72-90），生成器依次产出多个 disposer（:123-143），
// 其余值抛 TypeError 'Invalid effect'（:51，同步抛出，调用点直接 assert.throws）。
const isThenable = value => value !== null && typeof value === 'object' && typeof value.then === 'function'
const isIterable = value => value !== null && typeof value === 'object' && (typeof value[Symbol.iterator] === 'function' || typeof value[Symbol.asyncIterator] === 'function')

// 异步路径：Promise 兑现后的值、生成器 yield 出的值都递归走同一套分派。
const settleAsync = async (record, result) => {
  if (result === undefined || result === null) return
  if (typeof result === 'function') {
    record.disposers.push(result)
    return
  }
  if (isThenable(result)) {
    await settleAsync(record, await result)
    return
  }
  if (isIterable(result)) {
    for await (const yielded of result) await settleAsync(record, yielded)
    return
  }
  throw new TypeError('Invalid effect')
}

const collectDisposer = (record, result) => {
  if (result === undefined || result === null) return
  if (typeof result === 'function') {
    record.disposers.push(result)
    return
  }
  if (isThenable(result) || isIterable(result)) {
    // pending 标记让「body 已落定」的 effect 同步跑第一个 disposer（effects.test.js:150-154），
    // 只有真的在途时才等（:72-90）。
    record.pending = true
    record.settled = record.settled.then(async () => {
      await settleAsync(record, result)
      record.pending = false
    })
    return
  }
  throw new TypeError('Invalid effect')
}

// 处置一个 effect：一个 effect 的多个 disposer 逆序、串行（effects.test.js:123-143）。
const disposeEffect = record => {
  if (record.state === 'disposed') return record.task ?? Promise.resolve()
  if (record.state === 'disposing') return record.task
  record.state = 'disposing'
  record.task = (async () => {
    if (record.pending) await record.settled.catch(() => {})
    for (const dispose of [...record.disposers].reverse()) await dispose()
    record.state = 'disposed'
  })()
  // effects.test.js:156/163：提前处置过的 effect 不在卸载时二次处置，也不再出现在
  // fiber.getEffects() 里。
  const at = record.fiber.effects.indexOf(record)
  if (at >= 0) record.fiber.effects.splice(at, 1)
  return record.task
}

class Fiber {
  constructor(host, parent, { name = 'anonymous', inject = [] } = {}) {
    this.host = host
    this.parent = parent
    this.name = name
    this.inject = new Set(inject)
    this.children = []
    this.effects = []
    // tools-and-hidden.test.js:302-304：根 fiber uid 为 0，插件 fiber 为正整数。
    this.uid = parent === null ? 0 : ++host.uidCounter
    this.state = 'live'
    this.ready = Promise.resolve()
  }

  assertActive() {
    if (this.state !== 'live') throw inactiveError()
  }

  // effects.test.js:24-43：body 在注册时立即跑；返回的既可调用（立即处置）又是 thenable
  // （await 它只等 body 落定、不处置，:158-163）。
  effect(body, label = 'anonymous') {
    this.assertActive()
    const record = new EffectRecord(this, label)
    collectDisposer(record, body())
    this.effects.push(record)
    const disposer = () => disposeEffect(record)
    disposer[EFFECT] = { label }
    disposer.label = label
    disposer.then = (onFulfilled, onRejected) => record.settled.then(onFulfilled, onRejected)
    return disposer
  }

  // effects.test.js:39/163：按注册序列出存活 effect 的 label。
  getEffects() {
    return this.effects.map(record => ({ label: record.label }))
  }

  // host.js §1.4：`await fiber.await()` 等插件就绪、`await fiber.dispose()` 卸载。
  await() {
    return this.ready
  }

  dispose() {
    return this.unload()
  }

  // effects.test.js:145-156：返回的 disposer 幂等，二次调用拿回在途处置；提前处置过的 effect
  // 不在卸载时二次处置。
  unload() {
    if (this.state !== 'live') return this.ready
    this.state = 'unloading'
    // tools-and-hidden.test.js:309-311：uid 在卸载 disposer 运行**之前**就被清掉，disposer 里
    // 已经看到插件处于卸载态——parts.js:748 只靠 uid 检查覆盖的正是这个窗口。
    this.uid = null
    this.ready = (async () => {
      // effects.test.js:104-121：处置顺序 = 注册逆序，所有 disposer 先启动、再有谁完成，
      // 卸载等最慢的一个。
      const tasks = [...this.effects].reverse().map(disposeEffect)
      this.effects.length = 0
      await Promise.allSettled(tasks)
      // effects.test.js:243-247：嵌套上下文随父上下文一起走；父的同步 disposer 先落，
      // 子的卸载晚一个事件循环回合。
      for (const child of [...this.children].reverse()) await child.unload()
      this.state = 'unloaded'
      this.children.length = 0
    })()
    return this.ready
  }
}

// ============================================================================
// 2. Host：服务存储、事件总线、上下文代理、inject 与 plugin
// ============================================================================

// DSH Service 实例每次读回都是新的可追踪代理，跨读比较服务对象或方法身份没有意义
// （services.test.js:305-322）；普通 provide 的值则是同一对象（:317-321）。fake 用同一分界：
// 自己供给的服务默认值标 service 标记（每次读新代理、每次取成员新函数），测试 provide 的
// 普通值原样返回。
const traceService = value => new Proxy(value, {
  get: (target, prop) => {
    const member = target[prop]
    return typeof member === 'function' ? (...args) => member.apply(target, args) : member
  },
})

class Host {
  constructor({ logger } = {}) {
    this.services = new Map()
    this.hooks = new Map()
    this.routes = []
    this.interceptors = []
    this.agents = new Map()
    this.scopes = new Map()
    this.waiters = []
    this.uidCounter = 0
    this.logger = logger ?? { warn() {}, info() {} }
    this.rootFiber = new Fiber(this, null, { name: 'root' })
    this.ctx = this.contextOf(this.rootFiber, { isRoot: true })
  }

  // ---- 服务存储 -----------------------------------------------------------

  // services.test.js:83-86 的 providerPlugin 形态：provide 归属发起注册的 fiber，随它卸载释放
  // （:219-238）。
  provide(fiber, name, value, { service = false, bound = false } = {}) {
    fiber.assertActive()
    const entry = { value, fiber, service, bound }
    this.services.set(name, entry)
    fiber.effect(() => () => {
      if (this.services.get(name) === entry) this.services.delete(name)
      this.settleWaiters(name)
    }, `ctx.provide(${JSON.stringify(name)})`)
    this.settleWaiters(name)
    return () => {
      if (this.services.get(name) !== entry) return false
      this.services.delete(name)
      this.settleWaiters(name)
      return true
    }
  }

  // bound 服务（tools / connection）按**调用方上下文**现造 facade：register/restrict/guard 与
  // 路由注册必须归属发起调用的 fiber（tools-and-hidden.test.js:155-165、host.js §7）， facade 存
  // 在根上就归不了根以外的 fiber。
  resolve(entry, ctx) {
    if (entry.bound) return entry.value(ctx)
    return entry.service ? traceService(entry.value) : entry.value
  }

  // host.js §0 读法 2：ctx.get 无 inject 要求，任何已 provide 的服务都可读；无人提供的名字返回
  // undefined 且从不抛（services.test.js:134-145）。
  get(name, ctx = null) {
    const entry = this.services.get(name)
    if (entry === undefined) return undefined
    if (entry.fiber.state === 'unloaded') return undefined
    return this.resolve(entry, ctx)
  }

  // host.js §0 读法 1：属性读只对 inject 声明过的服务（或根上下文）可用，未注入时抛
  // "cannot get property \"<name>\" without inject"（services.test.js:147-170）。
  // 卸载后的上下文报 inactive 消息（tools-and-hidden.test.js:341-346）。
  readProperty(fiber, isRoot, prop, ctx) {
    if (fiber.state === 'unloaded') {
      if (this.services.has(prop) || this.declared(fiber, prop)) throw inactiveServiceError(prop)
      return undefined
    }
    const entry = this.services.get(prop)
    if (entry === undefined) return undefined
    if (isRoot || this.declared(fiber, prop) || this.ownsOrAncestor(entry, fiber)) {
      return this.resolve(entry, ctx)
    }
    throw new Error(`cannot get property "${prop}" without inject`)
  }

  declared(fiber, prop) {
    for (let at = fiber; at !== null; at = at.parent) if (at.inject.has(prop)) return true
    return false
  }

  ownsOrAncestor(entry, fiber) {
    for (let at = fiber; at !== null; at = at.parent) if (at === entry.fiber) return true
    return false
  }

  // ---- 上下文 -------------------------------------------------------------

  contextOf(fiber, { isRoot = false, agentScope = null } = {}) {
    const host = this
    let proxy
    const scope = {
      host,
      fiber,
      isRoot,
      agentScope,
      // ctx.get('<name>') 的第二个形参供 bound 服务拿调用方上下文；缺省就是本上下文。
      get: (name, ctx) => host.get(name, ctx ?? proxy),
      provide: (name, value, options) => host.provide(fiber, name, value, options),
      inject: (names, attach) => host.inject(fiber, names, attach),
      on: (name, listener, options) => host.on(fiber, name, listener, options),
      once: (name, listener, options) => host.once(fiber, name, listener, options),
      emit: (name, ...args) => host.emit(name, ...args),
      waterfall: (name, ...args) => host.waterfall(name, ...args),
      bail: (name, ...args) => host.bail(name, ...args),
      serial: (name, ...args) => host.serial(name, ...args),
      effect: (body, label) => fiber.effect(body, label),
      plugin: (plugin, config) => host.plugin(fiber, plugin, config),
      // host.js §1.1 logger：宿主日志，不是注入服务，卸载后仍可用
      // （tools-and-hidden.test.js:352-353）。
      logger: host.logger,
    }
    if (agentScope !== null) scope.tools = scopedTools(host, agentScope)
    // fiber 上记一份 agentScope：on() 靠它给监听打上 Agent 过滤（session-objects.test.js:274-292）。
    fiber.agentScope = agentScope
    // ctxScope 存**代理**而不是原始 scope：fiberHandle(ctx) 与各 face 都经它拿上下文，
    // 存裸对象会绕过服务解析陷阱。
    proxy = new Proxy(scope, {
      get(target, prop) {
        if (typeof prop !== 'string') return Reflect.get(target, prop)
        if (prop in target) return target[prop]
        return host.readProperty(fiber, isRoot, prop, proxy)
      },
      // 测试可以直接往 ctx 上贴覆盖（fake-ctx 时代的 Object.assign(ctx, {...}) 用法）。
      set(target, prop, value) {
        target[prop] = value
        return true
      },
      has(target, prop) {
        return prop in target || host.services.has(prop)
      },
    })
    fiber.ctxScope = proxy
    return proxy
  }

  // ---- plugin 挂载 --------------------------------------------------------

  // host.js §1.4：ctx.plugin(plugin, config?) → fiber；await fiber.await() 等就绪、
  // await fiber.dispose() 卸载（锁测试全程以这两个成员驱动真实挂载）。
  plugin(fiber, plugin, config) {
    fiber.assertActive()
    const apply = typeof plugin === 'function' ? plugin : plugin?.apply
    if (typeof apply !== 'function') {
      throw new Error(`invalid plugin, expect function or object with an "apply" method, received ${typeof plugin}`)
    }
    const child = this.childFiber(fiber, { name: plugin?.name ?? apply.name, inject: plugin?.inject ?? [] })
    const scope = this.contextOf(child)
    apply(scope, config)
    return fiberHandle(child)
  }

  // 子 fiber：挂载点、inject 目标、agent.ctx 都从这儿长出来。
  childFiber(parent, options = {}) {
    const child = new Fiber(this, parent, options)
    parent.children.push(child)
    return child
  }

  // ---- ctx.inject 动态注入 ------------------------------------------------

  // services.test.js:172-238 的全部锁定语义：等服务出现才执行 attach（晚到也能接上）、
  // 服务永不出现则 attach 永不执行而 fiber.await() 正常落定、attach 收到提供方自己的实例、
  // 同名第二次 inject 仍拿同一实例、提供方卸载时 attach 里注册的 effect disposer 随之释放。
  inject(fiber, names, attach) {
    fiber.assertActive()
    // 子 fiber 声明这些名字的 inject：attach 收到的子上下文因此能属性读被注入的服务
    // （services.test.js:182-184 的 sub.sessionProjections / sub.effect）。
    const child = this.childFiber(fiber, { name: `ctx.inject(${names.join(',')})`, inject: names })
    const sub = this.contextOf(child)
    const wanted = new Set(names)
    const waiter = { wanted, child, sub, attach, attached: false }
    const live = () => [...wanted].every(name => {
      const entry = this.services.get(name)
      return entry !== undefined && entry.fiber.state !== 'unloaded'
    })
    waiter.evaluate = () => {
      if (waiter.attached) {
        if (!live()) void child.unload().then(() => { waiter.attached = false })
        return
      }
      if (live()) {
        waiter.attached = true
        attach(sub)
      }
    }
    this.waiters.push(waiter)
    // await() 立即可落定：服务没出现也只是「能力未加载」，不是挂起（services.test.js:187-196）。
    child.ready = Promise.resolve().then(() => waiter.evaluate())
    waiter.evaluate()
    return fiberHandle(child)
  }

  settleWaiters(name) {
    for (const waiter of [...this.waiters]) {
      if (!waiter.wanted.has(name)) continue
      if (waiter.child.state === 'unloaded' || waiter.child.parent?.state !== 'live') continue
      waiter.evaluate()
    }
  }

  // ---- 事件总线 -----------------------------------------------------------

  // host.js §2 顺序语义：默认按注册序；{prepend:true} 插到该事件**所有**已注册监听之前；
  // 多个 prepend 后来者更靠前（events.test.js:88-127）。监听归属注册它的 fiber，卸载即移除
  // （:687-696）——与 cordis 一样，注册本身就是 fiber 上的一个 effect（events.ts:270-281）。
  on(fiber, name, listener, options = {}) {
    fiber.assertActive()
    const entry = { callback: listener, fiber, agent: fiber.agentScope?.agent ?? null }
    const list = this.hooks.get(name) ?? []
    if (options?.prepend) list.unshift(entry)
    else list.push(entry)
    this.hooks.set(name, list)
    const remove = () => {
      const at = list.indexOf(entry)
      if (at < 0) return false
      list.splice(at, 1)
      return true
    }
    const dispose = fiber.effect(() => remove, `ctx.on(${JSON.stringify(name)})`)
    return () => {
      remove()
      dispose()
    }
  }

  // events.test.js:682-685：once 只触发一次。
  once(fiber, name, listener, options) {
    let dispose = null
    const wrapper = (...args) => {
      dispose?.()
      return listener(...args)
    }
    dispose = this.on(fiber, name, wrapper, options)
    return dispose
  }

  // 监听器形参个数不决定形态（host.js §2 EventBus.on 注）：分发模式由发射方选。agent 作用域
  // 注册的监听只收自己 Agent 的事件（session-objects.test.js:274-292）；载荷里找不到 agent 时
  // 放行——真实侧的 Context.filter 对无 agent 事件同样不拦。
  agentOf(args) {
    for (const arg of args) {
      if (arg !== null && typeof arg === 'object' && arg.agent !== undefined && arg.agent !== null) return arg.agent
    }
    return null
  }

  reaches(entry, args) {
    if (entry.agent === null || entry.agent === undefined) return true
    const agent = this.agentOf(args)
    return agent === null || agent === entry.agent
  }

  listenersOf(name, args) {
    return (this.hooks.get(name) ?? []).filter(entry => this.reaches(entry, args))
  }

  // events.test.js:233-251：emit 同步、不等监听；同步 throw 直接逃出并中止后续监听；
  // 异步 rejection 无人接管（真实分发路径因此自己容纳监听错误，见 contained 注）。
  emit(name, ...args) {
    for (const entry of this.listenersOf(name, args)) entry.callback(...args)
  }

  // events.test.js:129-231 的 waterfall 全链：首注册者在最外层；await next() 等整条内链跑完；
  // 不调 next() 即消费（内链与 built-in 都不跑）；改 payload 对内层与 built-in 同时可见
  // （同一对象）；内层 throw 到达外层 await next() 可被捕获恢复，无人恢复则整个 dispatch
  // reject；无监听时落到 built-in（:274）。next 作为**最后一个实参**追加（cordis
  // events.ts:228-243），built-in 本身不收 next。
  waterfall(name, ...args) {
    const inner = args.pop()
    const list = this.listenersOf(name, args)
    const next = () => {
      const entry = list.shift()
      const callback = entry === undefined ? inner : entry.callback
      return callback(...args, next)
    }
    return next()
  }

  // events.test.js:272-273：bail / serial 无监听时返回 undefined。bail 值口径同 cordis 的
  // isBailed：非 null/false/undefined 即停（events.ts:15）。
  bail(name, ...args) {
    for (const entry of this.listenersOf(name, args)) {
      const result = entry.callback(...args)
      if (result !== null && result !== false && result !== undefined) return result
    }
    return undefined
  }

  async serial(name, ...args) {
    for (const entry of this.listenersOf(name, args)) {
      const result = await entry.callback(...args)
      if (result !== null && result !== false && result !== undefined) return result
    }
    return undefined
  }

  // 容纳监听错误的分发：真实 DSH 的 session/event 与 llm/adapters-updated 发射点自己吞掉监听
  // 错误并进 logger.warn（events.test.js:242-244 注、:581-604、:606-624）——plain ctx.emit 反而
  // 会让同步 throw 逃出（:233-240）。fake 的 session.append 与 llm.registerAdapter 走这条。
  contained(name, ...args) {
    const label = this.containLabel(name)
    for (const entry of this.listenersOf(name, args)) {
      try {
        const result = entry.callback(...args)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(undefined, error => this.logger.warn(`${label}: ${name} listener rejected: ${error}`))
        }
      } catch (error) {
        this.logger.warn(`${label}: ${name} listener threw: ${error}`)
      }
    }
  }

  // session/event 的消息前缀带会话 id（events.test.js:602-603），adapters-updated 用
  // "an <event> listener failed"（:623）。
  containLabel(name) {
    if (name === 'session/event') return `session "${this.containSessionId ?? 'unknown'}"`
    return `an ${name}`
  }

  // ---- 装配 ---------------------------------------------------------------

  dispose() {
    return this.rootFiber.unload()
  }
}

const fiberHandle = fiber => {
  const handle = {
    get uid() { return fiber.uid },
    get fiber() { return fiber },
    await: () => fiber.ready,
    dispose: () => fiber.unload(),
    getEffects: () => fiber.getEffects(),
    get ctx() { return fiber.ctxScope },
  }
  // cordis 的 plugin() 返回的就是 thenable fiber：await 它拿回 fiber 本身。兑现值必须是
  // **非 thenable** 的 fiber——兑现成 handle 会让 promise 解析过程反复解包同一 thenable 而死循环。
  handle.then = (onFulfilled, onRejected) => fiber.ready.then(
    () => (typeof onFulfilled === 'function' ? onFulfilled(fiber) : fiber),
    onRejected,
  )
  return handle
}

// ============================================================================
// 3. 工具面（ctx.tools register/schemas/restrict/guard）
// ============================================================================

// tools-and-hidden.test.js:113-290 锁定的全局语义；execute/get 只有锁测试驱动（host.js §8），
// fake 自备同形结果，让 L2 测试能跑执行面。
class ToolBoard {
  constructor(host) {
    this.host = host
    this.entries = []
    this.guards = []
  }

  globals() {
    return this.entries.filter(entry => entry.scope === null)
  }

  ownOf(scope) {
    return this.entries.filter(entry => entry.scope === scope)
  }

  globalNames() {
    return new Set(this.globals().map(entry => entry.tool.name))
  }

  // 限制只收窄继承的全局工具；deny 命中的工具在 schemas 与执行中都读作「不存在」
  // （tools-and-hidden.test.js:191-217）。多个 restrict 依次收窄（:219-234）。
  allowed(scope, name) {
    for (const restriction of scope?.restrictions ?? []) {
      if (restriction.allow !== null && !restriction.allow.has(name)) return false
      if (restriction.deny.has(name)) return false
    }
    return true
  }

  // tools-and-hidden.test.js:167-177：重名、保留名 run_code、缺 output 契约的 definition 都被拒。
  register(ctx, tool) {
    const name = tool?.name
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('fake-host: a tool must declare a name')
    if (name === 'run_code') throw new Error('tool name "run_code" is reserved for the PTC mode presentation transport')
    if (typeof tool.output?.render !== 'function' || tool.output.schema === undefined) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    const scope = ctx.agentScope ?? null
    if (this.entries.some(entry => entry.tool.name === name && entry.scope === scope)) {
      throw new Error(`tool "${name}" is already registered (for a per-agent variant, dispose the first one)`)
    }
    const entry = { tool, fiber: ctx.fiber, scope }
    this.entries.push(entry)
    // tools-and-hidden.test.js:155-165：注册归属发起注册的 fiber，插件卸载即消失。
    const remove = () => {
      const at = this.entries.indexOf(entry)
      if (at < 0) return false
      this.entries.splice(at, 1)
      return true
    }
    ctx.fiber.effect(() => remove, `tools.register(${JSON.stringify(name)})`)
    return remove
  }

  // tools-and-hidden.test.js:120-131：只投影面向模型的字段（无 execute/output 回调），每次读回
  // 都是新的深拷贝；parameters 包成 JSON schema 的 object 形状（与真实 ToolRuntime 一致）。
  // :179-189：传 agent 得该 agent 的可见面，未限制过的 agent 与全局视图一致。
  schemas(agent) {
    const scope = this.host.scopes.get(agent)
    const visible = [
      ...this.globals().filter(entry => this.allowed(scope, entry.tool.name)),
      ...this.ownOf(scope),
    ]
    return visible.map(entry => ({
      name: entry.tool.name,
      description: entry.tool.description,
      parameters: { type: 'object', properties: deepClone(entry.tool.parameters ?? {}) },
    }))
  }

  get(name, agent) {
    const scope = this.host.scopes.get(agent)
    const own = this.ownOf(scope).find(entry => entry.tool.name === name)
    if (own !== undefined) return own.tool
    const global = this.globals().find(entry => entry.tool.name === name)
    if (global !== undefined && this.allowed(scope, name)) return global.tool
    return undefined
  }

  // tools-and-hidden.test.js:236-243：空过滤、未知全局名、在根上下文调用都被拒。
  // :229-233：作用域自己的注册不是「全局工具」，不能被过滤器点名（落进未知全局名一支）。
  restrict(ctx, filter = {}) {
    const scope = ctx.agentScope ?? null
    if (scope === null) throw new Error('tools.restrict requires a scoped context (agent.ctx)')
    const allow = Array.isArray(filter.allow) ? filter.allow.filter(name => typeof name === 'string') : []
    const deny = Array.isArray(filter.deny) ? filter.deny.filter(name => typeof name === 'string') : []
    if (allow.length === 0 && deny.length === 0) throw new Error('tools.restrict({}) is a no-op')
    const known = [...this.globalNames()]
    for (const name of [...allow, ...deny]) {
      if (!this.globalNames().has(name)) {
        throw new Error(`tools.restrict filter names unknown global tool "${name}"; known global tools: ${known.join(', ')}`)
      }
    }
    const restriction = { allow: allow.length > 0 ? new Set(allow) : null, deny: new Set(deny) }
    scope.restrictions.push(restriction)
    const lift = () => {
      const at = scope.restrictions.indexOf(restriction)
      if (at < 0) return false
      scope.restrictions.splice(at, 1)
      return true
    }
    return lift
  }

  // tools-and-hidden.test.js:245-290：guard 在工具体之前判定；多个 guard 按注册序跑、第一个
  // 拒绝生效、后续 guard 不被触达；返回 lift 函数解除。「任何 guard 都不能强制放行」是从
  // string|undefined 返回类型推出的推断（host.js §6），锁测试只证明了顺序与首个拒绝——fake 同样
  // 只实现「undefined 放行、string 拒绝」。
  guard(ctx, guard) {
    const entry = { guard, fiber: ctx.fiber }
    this.guards.push(entry)
    const lift = () => {
      const at = this.guards.indexOf(entry)
      if (at < 0) return false
      this.guards.splice(at, 1)
      return true
    }
    ctx.fiber.effect(() => lift, 'tools.guard')
    return lift
  }

  // host.js §8：execute/get 只有锁测试驱动、src/host 无调用点，fake 自备同形结果。
  // events.test.js:339-428：tools/execute 是 waterfall——中间件改写到达工具体（exec 是同一对象）、
  // veto 让工具体不跑、throw 变成结构化工具错误而不是 execute() reject、未知名也走完整链。
  async execute(call) {
    const exec = {
      name: call.name,
      arguments: call.arguments !== null && typeof call.arguments === 'object' ? Object.freeze({ ...call.arguments }) : call.arguments,
      agent: call.agent,
      signal: call.signal,
      callId: call.callId,
    }
    try {
      return Object.freeze(await this.host.waterfall('tools/execute', exec, () => this.builtin(exec)))
    } catch (error) {
      return toolError(error)
    }
  }

  async builtin(exec) {
    for (const entry of [...this.guards]) {
      const denial = entry.guard(exec)
      if (typeof denial === 'string') return toolError(new Error(denial))
    }
    const tool = this.get(exec.name, exec.agent)
    if (tool === undefined) {
      return toolError(Object.assign(new Error(`unknown tool "${exec.name}"`), { info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } }))
    }
    try {
      // DSH waits for the tool body: a rejection comes back as a structured tool error here
      // instead of escaping as unhandled activity, and output.render sees the value.
      const value = await tool.execute(exec.arguments, exec)
      return Object.freeze({ isError: false, value, content: tool.output.render(exec.arguments, value) })
    } catch (error) {
      return toolError(error)
    }
  }
}

// tools-and-hidden.test.js:148-152/260-262 的结果形状：冻结快照，error.info 带结构化分类。
const toolError = error => Object.freeze({
  isError: true,
  error: { message: error.message, info: error.info },
  content: [{ type: 'text', text: `Error: ${error.message}` }],
})

// 全局工具面：register/restrict/guard 按**调用方上下文**归属 fiber，所以它是 bound 服务——
// 每次读回按读取它的 ctx 现造（见 Host.resolve）。
const globalTools = (host, ctx) => ({
  register: tool => host.tools.register(ctx, tool),
  schemas: agent => host.tools.schemas(agent),
  restrict: filter => host.tools.restrict(ctx, filter),
  guard: guard => host.tools.guard(ctx, guard),
  execute: call => host.tools.execute(call),
  get: (name, agent) => host.tools.get(name, agent),
})

// host.js §3 AgentContext：src/host 只用 restrict/effect/plugin 三个成员；on 与 tools.register
// 只被锁测试驱动（§1b/§8），fake 一并自备。
const scopedTools = (host, agentScope) => ({
  register: tool => host.tools.register(agentScope.ctx, tool),
  schemas: () => host.tools.schemas(agentScope.agent),
  restrict: filter => host.tools.restrict(agentScope.ctx, filter),
  guard: guard => host.tools.guard(agentScope.ctx, guard),
  execute: call => host.tools.execute(call),
  get: name => host.tools.get(name, agentScope.agent),
})

// ============================================================================
// 4. 连接面（ctx.connection.fetch.register）
// ============================================================================

// tools-and-hidden.test.js:445-468 的注册表校验与拒绝；:356-443 的路由语义。锁测试为驱动路由
// 另用了 createSharedFetchHandler / rpc.intercept / createPeer（host.js §8 范围外）——fake 自备
// 同形最小实现，让「精确路由先于共享通道、未覆盖落回、方法不符 404、非 owner 403」可被断言。
const registerRoute = (host, fiber, route) => {
  if (typeof route?.path !== 'string' || !route.path.startsWith('/api') || route.path.includes('..')) {
    throw new Error(`connection: invalid exact Fetch route "${route?.path}"`)
  }
  if (!Array.isArray(route.methods) || route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route "${route.path}" declares no methods`)
  }
  if (new Set(route.methods).size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route "${route.path}" repeats a method`)
  }
  if (typeof route.fetch !== 'function') {
    throw new Error(`connection: exact Fetch route "${route.path}" declares no fetch handler`)
  }
  if (host.routes.some(live => live.path === route.path)) {
    throw new Error(`connection: exact Fetch route "${route.path}" is already registered`)
  }
  const entry = { path: route.path, methods: [...route.methods], fetch: route.fetch }
  host.routes.push(entry)
  // 路由归属注册它的 fiber（host.js §7；锁测试里 effect 的 disposer 就是 register 的返回值，
  // 两条路径都指向同一次摘除，remove 幂等）。
  const remove = () => {
    const at = host.routes.indexOf(entry)
    if (at < 0) return false
    host.routes.splice(at, 1)
    return true
  }
  fiber.effect(() => remove, `connection.fetch.register(${JSON.stringify(route.path)})`)
  return remove
}

const connectionFace = (host, ctx) => ({
  fetch: { register: route => registerRoute(host, ctx.fiber, route) },
  rpc: {
    intercept: (prefix, match, handler) => {
      const entry = { prefix, match, handler }
      host.interceptors.push(entry)
      const remove = () => {
        const at = host.interceptors.indexOf(entry)
        if (at < 0) return false
        host.interceptors.splice(at, 1)
        return true
      }
      ctx.fiber.effect(() => remove, `connection.rpc.intercept(${JSON.stringify(prefix)})`)
      return remove
    },
  },
  createSharedFetchHandler: prefix => ({
    // 未覆盖路径默认同为 buffered（tools-and-hidden.test.js:398-402）。
    requestBodyMode: () => 'buffered',
    fetch: async (request, peer) => {
      const url = new URL(request.url)
      if (peer?.principal?.kind !== 'owner') return new Response('forbidden', { status: 403 })
      const route = host.routes.find(entry => entry.path === url.pathname)
      if (route !== undefined) {
        // 路由不声明的方法与未覆盖路径都得 404（:429-431、:461-463）。
        if (!route.methods.includes(request.method)) return new Response('not found', { status: 404 })
        return route.fetch(request)
      }
      // 共享 RPC 通道是 POST-only（:429-431）。
      if (request.method !== 'POST') return new Response('not found', { status: 404 })
      const envelope = await request.json()
      for (const interceptor of host.interceptors) {
        if (!interceptor.prefix.startsWith(prefix) || !interceptor.match(envelope.method)) continue
        const result = await interceptor.handler(envelope.method, envelope.payload, request.signal, peer)
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
      }
      return new Response('not found', { status: 404 })
    },
  }),
  browserPeer: { principal: { kind: 'owner' } },
  createPeer: ({ principal }) => ({ principal }),
})

// ============================================================================
// 5. 对象面：Session / inbox / Agent 的可编程 fake
// ============================================================================

// session-objects.test.js:311-324 锁定的 surface-op 契约：产消息事件必须声明 surfaceOp、纯日志
// 事件不得声明、sourceEventSeqs 显式空数组拒绝。src/host 唯一 append 调用点是 images.js:202 的
// 'image/offload'（不带 surfaceOp，即非 surface-eligible），所以默认集合只含锁测试钉过的
// 'user/message'；词汇表未锁定，测试可经 options.surfaceEligible 扩充。
const SURFACE_ELIGIBLE = new Set(['user/message'])

// host.js §3 SessionObject：seq 是日志长度（:361-379）、append 恰增一（:294-309）、header 冻结
// （:381-393）、requestHeader 折叠且缓存（:395-416）、deriveMessages 每次新数组、元素共享冻结
// 且跟随 surface 替换（:418-456）。snapshotEvents 只有锁测试驱动（host.js §8），一并自备。
export function fakeSession(host, { id = `session-${host.agents.size + 1}`, cwd = process.cwd(), surfaceEligible = [] } = {}) {
  const eligible = new Set([...SURFACE_ELIGIBLE, ...surfaceEligible])
  const log = []
  const surface = []
  const projections = new Map([['inbox', { 'next-step': [], 'next-turn': [] }]])
  let requestHeaderValue
  const session = {
    id,
    host,
    seq: 0,
    header: Object.freeze({ version: 4, id, cwd, isSeeded: false, createdAt: Date.now() }),
    append(type, data, options = {}) {
      const surfaceOp = options.surfaceOp
      const sourceEventSeqs = options.sourceEventSeqs
      if (eligible.has(type) && surfaceOp === undefined) {
        throw new Error(`session.append: a message-producing event "${type}" must declare surfaceOp`)
      }
      if (!eligible.has(type) && surfaceOp !== undefined) {
        throw new Error(`session.append: the log-only event "${type}" is not surface-eligible`)
      }
      if (Array.isArray(sourceEventSeqs) && sourceEventSeqs.length === 0) {
        throw new Error('session.append: sourceEventSeqs must not be empty')
      }
      // session-objects.test.js:326-339：image/offload 只在对应投影已注册时被接受，且拒绝时
      // 日志不变（先校验后落账）。
      if (type === 'image/offload' && !host.get('sessions').messageProjections.some(projection => projection.type === 'image/offload')) {
        throw new Error('session.append: "image/offload" requires a message projection')
      }
      // events.test.js:576-577：事件与载荷都冻结；深冻让派生消息的 content 也冻住
      // （session-objects.test.js:436-438）——必须先深冻再浅冻，否则 deepFreeze 会被
      // 已冻结的外层挡住。
      const event = Object.freeze({ type, seq: session.seq, time: Date.now(), data: deepFreeze(data) })
      log.push(event)
      session.seq += 1
      if (surfaceOp === 'append') surface.push({ seq: event.seq, message: deepFreeze(data) })
      else if (surfaceOp !== undefined) {
        const { op, startSeq, endSeq } = typeof surfaceOp === 'object' ? surfaceOp : { op: surfaceOp }
        if (op !== 'replace') throw new Error(`session.append: unsupported surfaceOp "${op}"`)
        const from = surface.findIndex(entry => entry.seq >= startSeq)
        const to = surface.findIndex(entry => entry.seq > endSeq)
        const at = from < 0 ? surface.length : from
        surface.splice(at, to < 0 ? surface.length - at : to - at, { seq: event.seq, message: deepFreeze(data) })
      }
      if (type === 'request/header') requestHeaderValue = { ...requestHeaderValue, ...data.header }
      // events.test.js:561-604：session/event 是同步通知，注册序 + prepend、载荷深冻结、
      // append 不受监听错误影响（错误进 logger.warn）。
      host.containSessionId = id
      host.contained('session/event', session, event)
      return event
    },
    eventAt: seq => log[seq],
    requestHeader: () => requestHeaderValue,
    deriveMessages: () => surface.map(entry => entry.message),
    snapshotEvents: () => [...log],
    projections,
  }
  return session
}

// session-objects.test.js:69-134：两个命名列表、计算键访问同样有效；prepend 插头、append 接尾；
// remove 按 id 移除并报告是否曾在队列；clear 先 next-step 后 next-turn；hasPending 反映待办。
// 每次变异都是持久 splice（事件 type 'agent/inbox/spliced'，data { target, start, inserted,
// outcome? }），且活列表与持久 inbox 投影随后一致（:81-119）。
const fakeInbox = (session, agentOf) => {
  const inbox = {
    nextStep: [],
    nextTurn: [],
    prepend(list, message) { return splice(inbox, session, agentOf, list, 0, [message]) },
    append(list, message) { return splice(inbox, session, agentOf, list, queueOf(inbox, list).length, [message]) },
    remove(messageId) {
      for (const list of ['next-step', 'next-turn']) {
        const queue = queueOf(inbox, list)
        const at = queue.findIndex(message => message?.id === messageId)
        if (at < 0) continue
        const [removed] = queue.splice(at, 1)
        recordSplice(session, list, at, [], undefined)
        syncProjection(inbox, session)
        return removed !== undefined
      }
      return false
    },
    clear() {
      // :121-133：canceled splice 先 next-step 后 next-turn；空列表不产事件（:216-227 的
      // outcomes [undefined, 'canceled'] 即按此口径）。
      for (const list of ['next-step', 'next-turn']) {
        const queue = queueOf(inbox, list)
        if (queue.length === 0) continue
        queue.splice(0, queue.length)
        recordSplice(session, list, 0, [], 'canceled')
      }
      syncProjection(inbox, session)
    },
    get hasPending() {
      return inbox.nextStep.length + inbox.nextTurn.length > 0
    },
  }
  return inbox
}

const queueOf = (inbox, list) => (list === 'next-turn' ? inbox.nextTurn : inbox.nextStep)

const splice = (inbox, session, agentOf, list, start, inserted) => {
  const queue = queueOf(inbox, list)
  queue.splice(start, 0, ...inserted)
  recordSplice(session, list, start, inserted, undefined)
  syncProjection(inbox, session)
  // session-objects.test.js:185-186 的 agent/inbox/inserted 通知（载荷形状未锁定；带 agent 是
  // 为了让 agent.ctx 上的监听按 Agent 过滤，与 :274-292 的 agent/status 同机制）。
  session.host.contained('agent/inbox/inserted', { message: inserted[0], agent: agentOf() })
}

const recordSplice = (session, target, start, inserted, outcome) => {
  session.append('agent/inbox/spliced', { target, start, inserted, outcome })
}

const syncProjection = (inbox, session) => {
  const state = session.projections.get('inbox')
  state['next-step'] = [...inbox.nextStep]
  state['next-turn'] = [...inbox.nextTurn]
}

// host.js §3 AgentObject：src/host 实读 id/session/status/whenIdle/send/followup/cancel/inbox/ctx，
// steer/inject/runMaintenance 无锁测（见下）。driver 是可编程的：测试装什么，一个 turn 就跑什么。
export function fakeAgent(host, { id = `agent-${host.agents.size + 1}`, session = fakeSession(host, { id }), driver, config = { provider: 'fake', model: 'fake-1' } } = {}) {
  const inbox = fakeInbox(session, () => agent)
  const scope = { agent: null, restrictions: [] }
  const idleWaiters = []
  const controller = new AbortController()
  let turn = 0
  let inFlight = null

  const settleIdle = () => {
    if (agent.status === 'idle' && inFlight === null) idleWaiters.splice(0).forEach(resolve => resolve())
  }

  // session-objects.test.js:146-180：一个 wake 抽干整个待办队列——第一步认领所有 next-step 消息
  // 加单条排队的 turn，之后每条剩余 turn 消息各自成 turn。
  const claim = () => {
    const messages = inbox.nextStep.splice(0, inbox.nextStep.length)
    const next = inbox.nextTurn.shift()
    if (next !== undefined) messages.push(next)
    syncProjection(inbox, session)
    return messages
  }

  const runTurn = async messages => {
    turn += 1
    const at = turn
    session.append('turn/start', { turn: at })
    session.append('request/header', { header: { config }, reason: 'turn' })
    for (const message of messages) host.contained('agent/inbox/claimed', { message, turn: at })
    await (driver ?? defaultDriver)({ turn: at, messages, signal: controller.signal, agent })
  }

  // session-objects.test.js:182-193：followup 排队并唤醒驱动，**返回前消息已被认领**——唤醒同步
  // 跑到 driver 的第一个 await，所以消息已经离开 inbox。status 同步翻 'running'。
  const wake = () => {
    if (inFlight !== null) return
    const messages = claim()
    if (messages.length === 0) return
    agent.status = 'running'
    // session-objects.test.js:289：agent/status 取值 'running'/'idle'，载荷带 agent——
    // agent.ctx 上的监听由此按 Agent 过滤（:274-292）。
    host.contained('agent/status', { agent, status: 'running' })
    inFlight = (async () => {
      try {
        await runTurn(messages)
        while (inbox.hasPending) await runTurn(claim())
      } finally {
        inFlight = null
        agent.status = 'idle'
        host.contained('agent/status', { agent, status: 'idle' })
        settleIdle()
      }
    })()
  }

  // 默认 driver：把认领到的消息按原样落成持久 user/message（保留调用方给的 id 与 source，
  // session-objects.test.js:201-214），不合成 assistant 消息——真实循环的合成形态未锁定，
  // 测试要断言历史就自备 driver。
  const defaultDriver = async ({ messages }) => {
    for (const message of messages) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
  }

  const agent = {
    id,
    session,
    status: 'idle',
    inbox,
    whenIdle: () => (agent.status === 'idle' && inFlight === null ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve))),
    // :136-152：wake=false 只入队不唤醒。
    send(message, list = 'next-turn', wakeIt = true) {
      inbox.append(list, message)
      if (wakeIt) wake()
    },
    followup(message) {
      inbox.append('next-turn', message)
      wake()
    },
    // :216-227：取消待办；keepInbox 保留 inbox，否则清空。在跑的 turn 交给 driver 自己收尾
    // （signal 已中止）——fake 不强制中断 driver。
    cancel(reason, options = {}) {
      if (options.keepInbox !== true) inbox.clear()
      controller.abort()
      if (inFlight === null) settleIdle()
    },
    // host.js §3：steer 把消息切入正在运行的 turn 的下一步。**未锁定**（无锁测）——fake 取
    // 「插到 next-step 头部」，与「切进下一步」的注释语义一致；inject 同属未锁定，取
    // 「入 next-step 队尾、不唤醒」（parts.js:738-739 按 source.kind 分流的另一支）。
    steer(message) {
      inbox.prepend('next-step', message)
    },
    inject(message) {
      inbox.append('next-step', message)
    },
    runMaintenance(job) {
      return job(controller.signal)
    },
  }
  scope.agent = agent
  host.agents.set(id, agent)
  host.scopes.set(agent, scope)
  // agent.ctx 是 Agent 作用域的上下文：贡献随 Agent 拆卸（session-objects.test.js:260-272），
  // 监听按 Agent 过滤（:274-292），工具限制不外溢到根（:229-258）。
  agent.ctx = host.contextOf(host.childFiber(host.rootFiber, { name: `agent:${id}` }), { agentScope: scope })
  scope.ctx = agent.ctx
  agent.dispose = () => agent.ctx.fiber.unload()
  return agent
}

// ============================================================================
// 6. 八个硬注入服务的默认实现（index.js:48）
// ============================================================================

// host.js §1.1 LlmService：七个成员。stream 的形状由 llm/stream 中间件链决定——最外层监听
// 返回异步生成器就是生成器，声明 async 就包一层 Promise（events.test.js:521-540）；内置行为问
// 已注册适配器要流。chunk 数据形状**未锁定**（host.js §1.1），默认适配器给一个最小三件套。
const defaultAdapter = {
  async *stream() {
    yield { type: 'text-delta', index: 0, text: '' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const llmFace = host => {
  const adapters = []
  const find = provider => adapters.find(entry => entry.ids.has(provider))
  const announce = () => host.contained('llm/adapters-updated')
  return {
    stream(options) {
      return host.waterfall('llm/stream', options, async function* builtin() {
        const adapter = find(options.provider)?.adapter ?? defaultAdapter
        for await (const chunk of adapter.stream(options)) yield chunk
      })
    },
    // 返回结构**未锁定**（host.js §1.1）；取锁测试里 mock 适配器同款的形状
    // （tools-and-hidden.test.js:49-58）。
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 100000 } }
    },
    listConfigurableProviders: () => [],
    // host.js §1.1 AdapterHandle：句柄可调用（注销）且带 replace(ids) 换绑；注册与注销都触发
    // llm/adapters-updated（events.test.js:606-624）。
    registerAdapter(ids, adapter) {
      const entry = { ids: new Set(ids ?? []), adapter }
      adapters.push(entry)
      announce()
      const handle = () => {
        const at = adapters.indexOf(entry)
        if (at < 0) return false
        adapters.splice(at, 1)
        announce()
        return true
      }
      handle.replace = nextIds => {
        entry.ids = new Set(nextIds ?? [])
        announce()
      }
      return handle
    },
    listProviders: () => adapters.map(entry => ({ id: [...entry.ids][0] })),
    async listModels(provider) {
      const adapter = find(provider)?.adapter
      return adapter?.listModels ? adapter.listModels() : []
    },
    async discoverModels() {
      return []
    },
  }
}

// host.js §1.1 SystemPromptService：src/host 两处都写成
// `ctx.effect(() => ctx.systemPrompt.section({...}))`——按 effect 契约，section 的返回值被当作
// disposer 收取（锁测试没有直接钉 section 的返回值，services.test.js:30 只断言可调用）。
const systemPromptFace = host => {
  const sections = []
  return {
    section(section) {
      sections.push(section)
      return () => {
        const at = sections.indexOf(section)
        if (at < 0) return false
        sections.splice(at, 1)
        return true
      }
    },
    // events.test.js:430-464 的 system-prompt/assemble：最外层监听的返回值就是 DSH 采用的
    // assembly，veto 整体替换。src/host 无 assemble 调用点（host.js §1.1），fake 自备以便 L2
    // 测试跑到 parts.js:1092 的 prepend 监听。
    assemble(context) {
      const assembly = { sections: sections.map(section => ({ ...section })), contexts: [], tools: [], variables: {} }
      return host.waterfall('system-prompt/assemble', assembly, context, () => assembly)
    },
  }
}

// host.js §1.1 SessionControllerService：八成员，各成员入参/返回结构一律未锁定——中性空默认，
// resolveAgent 接 fake agent 登记表。
const sessionControllerFace = host => ({
  page: async () => ({ items: [] }),
  create: async () => ({ sessionId: `session-${host.agents.size + 1}` }),
  selectModel: async () => ({}),
  resolveAgent: async sessionId => host.agents.get(sessionId),
  prompt: async () => undefined,
  projections: async () => ({ items: [] }),
  list: async () => ({ items: [] }),
  inspect: async () => ({ events: [] }),
})

// host.js §1.1 SessionsService：flush 可调用、messageProjections 是对象数组（images.js:199 据此
// 判断 image/offload 投影在不在，session-objects.test.js:333）。
const sessionsFace = host => ({
  messageProjections: [],
  flush: async () => undefined,
  create: (id, options = {}) => fakeSession(host, { id, cwd: options.meta?.cwd }),
})

const workspaceRegistryFace = () => {
  const workspaces = new Map()
  return {
    get: id => workspaces.get(id),
    resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
    create: async (path, name) => {
      const workspace = { id: `w${workspaces.size + 1}`, path, name }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    list: () => [...workspaces.values()],
    archiveSession: async () => undefined,
  }
}

const injectedFaces = host => ({
  llm: llmFace(host),
  tools: ctx => globalTools(host, ctx),
  systemPrompt: systemPromptFace(host),
  sessionController: sessionControllerFace(host),
  sessions: sessionsFace(host),
  sessionTitle: { rename: async () => undefined },
  workspaceRegistry: workspaceRegistryFace(),
  connection: ctx => connectionFace(host, ctx),
})

// ============================================================================
// 7. 21 个可选服务的默认实现（host.js §1.2）
// ============================================================================

// A 组（锁测试断言过成员的）：schedule.catalog 新 home 返回 []（services.test.js:131/253-254）、
// approval.request 无人应答 fail closed（events.test.js:658）、sessionProjections.register/stateOf
// （services.test.js:182-183）、shellEnv.register、goals.get/block 可调用。
// B 组（仅存在性已锁、成员名来自 src/host 实测）：中性空默认——静默默认不会假装副作用发生过，
// 测试按需经 fakeHost({ services }) 覆盖。逐个成员的二选一理由写在行内。
const optionalFaces = host => ({
  agentDefaultModel: { currentSelection: () => undefined, saveSelection: () => undefined },
  agentPresets: { serviceFor: () => undefined, list: () => [] },
  // events.test.js:626-670：无人应答时链走完即 fail closed 'unavailable'。
  approval: { request: async () => 'unavailable' },
  // 成员面未锁定（services.test.js 的 SERVICE_MEMBERS 表没有 attachments）：内存最小实现，
  // 读回按 1001 字节分块，和流式读一致。
  attachments: (() => {
    const files = new Map()
    return {
      async saveFile({ data, name }) {
        const ref = { attachmentId: `sha256:${files.size + 1}`, name, bytes: data.length }
        files.set(ref.attachmentId, data)
        return ref
      },
      async saveImages(inputs) {
        return inputs.map(input => ({ attachmentId: `sha256:${files.size + 1}`, mediaType: input?.mediaType }))
      },
      async *readFileStream(ref) {
        const data = files.get(ref.attachmentId)
        if (data === undefined) throw new Error('no such file')
        for (let at = 0; at < data.length; at += 1001) yield data.subarray(at, at + 1001)
      },
    }
  })(),
  // parts.js:298 的 effect 会整体换掉 .compact：给一个可替换的空壳即可。
  compaction: { compact: () => undefined },
  credentials: { describe: () => ({}), set: () => undefined, unset: () => undefined },
  // 账号面：getState 的 status 词表取自调用点（account.js 只读 'signed-out'/'credential-stored'）；
  // startSignIn 会开真实浏览器授权——选「抛」，见 notConfigured 注。watch 是异步可迭代，
  // signal 中止即结束（形状未锁定）。
  deepseekAccount: {
    getState: () => ({ status: 'signed-out' }),
    startSignIn: notConfigured('deepseekAccount.startSignIn'),
    cancelSignIn: () => undefined,
    signOut: () => undefined,
    watch: async function* (signal) {
      if (signal === undefined) return
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
  },
  // folders.js:167 包了 try/catch：能力缺失正是它预期的形态，选「抛」。
  directoryPicker: { capability: notConfigured('directoryPicker.capability') },
  goals: { get: () => undefined, block: () => undefined },
  // loader.import 会挂真实 MCP 客户端（services.test.js:257-280）——超出 fake 范围，选「抛」；
  // unwrapExports 是纯形状解包，给默认。
  loader: { import: notConfigured('loader.import'), unwrapExports: exports => exports?.default ?? exports },
  // permissions.js:11-16 读 { options, defaultPreset } 并过滤 option.value：中性空目录。
  permissionPresets: { catalog: () => ({ options: [], defaultPreset: null }), set: () => undefined, resolve: () => undefined },
  // update.js:75-88 读 configured.registry / fallbackRegistries / resolved 与 bundle.name/source：
  // 中性空。installBundle 会真实装包，选「抛」。
  pluginManager: {
    registries: () => ({ configured: {}, fallbackRegistries: [], resolved: {} }),
    listBundles: () => [],
    installBundle: notConfigured('pluginManager.installBundle'),
  },
  // browser.js:249、dsh-update.js:75/81、update.js:91 读 .name / .packageManager?.command / .dir。
  profileContext: { name: 'fake-host', packageManager: { command: 'npm' }, dir: host.options?.home ?? process.cwd() },
  // folders.js:143 只比对 'workspace-write'：给一个不等于它的中性 mode（词汇未锁定）。
  sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
  schedule: {
    catalog: async () => [],
    create: async () => ({}),
    delete: async () => undefined,
    list: async () => [],
  },
  sessionProjections: {
    // services.test.js:182-183：register/stateOf 可调用。register 顺带把投影挂到
    // sessions.messageProjections——session-objects.test.js:333/339 的 image/offload 门依此可过。
    register(projection) {
      const projections = host.get('sessions').messageProjections
      if (projection?.type !== undefined && !projections.some(live => live.type === projection.type)) projections.push(projection)
      return () => {
        const at = projections.indexOf(projection)
        if (at < 0) return false
        projections.splice(at, 1)
        return true
      }
    },
    stateOf: (session, key) => session?.projections?.get?.(key),
  },
  settings: { describe: () => ({}), mutate: () => ({}) },
  // secrets.js:550-560 以 { name, variables, resolve } 注册并收回注销函数。
  shellEnv: { register: () => () => {} },
  // parts.js:220 读 .measure(session).totalTokens。
  tokenMeter: { measure: () => ({ totalTokens: 0 }) },
  // account.js:52 读 .getOrigin() 作回调 origin：可经 services 覆盖，默认给回环地址。
  webServer: { getOrigin: () => 'http://127.0.0.1' },
  // folders.js:49、parts.js:1094 的 .get(session)（可空选）：回 session header 的 cwd。
  workingDirectory: { get: session => session?.header?.cwd },
})

// ============================================================================
// 8. 装配面：按契约造 host / 造 rt
// ============================================================================

// fakeHost：一个完整的契约宿主——八个硬注入服务 + 21 个可选服务的默认值都在位，服务存储、
// 事件总线、工具面、连接面齐备。options.services 里的普通值按 provide 语义覆盖同名默认
// （同一引用返回，services.test.js:317-321）。
export function fakeHost({ services = {}, logger, home } = {}) {
  const host = new Host({ logger })
  host.options = { home }
  host.tools = new ToolBoard(host)
  // 默认服务由**一个挂在根下的插件 fiber** 提供，而不是根本 fiber：src/host 各模块装在自己的
  // 插件作用域里，服务若由根提供，属性读会因为「根是每个作用域的祖先」而全部放行，丢掉
  // services.test.js:147-170 钉住的 without-inject 语义（真实侧这些服务也是由平级的插件
  // 提供的，events.test.js:344 的根读平级提供正对应此处的 isRoot 放行）。
  const faces = injectedFaces(host)
  const optional = optionalFaces(host)
  const mount = plugin => host.plugin(host.rootFiber, plugin)
  host.testServices = mount({
    name: 'fake-host-services',
    apply(scope) {
      for (const name of INJECTED_SERVICES) {
        // tools / connection 按调用上下文现造（register/restrict/guard 与路由的 fiber 归属），
        // 是 bound 服务；其余是静态 face，按 DSH Service 的读法每次读回新代理。
        const bound = name === 'tools' || name === 'connection'
        scope.provide(name, faces[name], { bound, service: !bound })
      }
      for (const name of OPTIONAL_SERVICES) scope.provide(name, optional[name], { service: true })
    },
  })
  for (const [name, value] of Object.entries(services)) {
    host.provide(host.testServices.fiber, name, value)
  }
  return host
}

// index.js:82-103 的 rt 形状（ctx/config/dshHome/home/statePath/defaults）。dshHome 真值来自
// folders.dshHomeOf(process.env.DSH_HOME)——本包不 import src/host 其它模块，保持零 DSH 闭包，
// 需要真 rt 的测试经 create 注入。
const defaultRuntime = (ctx, { home, config = {} }) => ({
  ctx,
  config,
  dshHome: process.env.DSH_HOME ?? null,
  home,
  statePath: `${home}/state.json`,
  defaults: {
    mainName: config.mainName ?? 'Chief',
    mainRole: config.mainRole ?? 'Chief of Staff',
  },
})

// 装配面：一个「按契约造 rt」的工厂，供将来 test/*.test.js 只换供给不改断言地迁移到 fake-host。
// 形态 = fakeRuntime({ home, config, services, create }) → { host, ctx, rt, dispose }：
//   - ctx 是**声明了 index.js:48 八个 inject 的子上下文**——正是 index.js apply(ctx) 拿到的那个
//     作用域，src/host 对八服务的属性读因此可用，可选服务照契约走 ctx.get；
//   - rt 默认按 index.js:82-103 的形状造；传 create（例如 createRuntime 本身）就改喂真实装配，
//     断言一字不改。
// 为什么用依赖注入而不是直接 import index.js：index.js 是 DSH 装配入口，静态 import llm-dsh.js
// 取 LlmAdapter 基类；DSH-free 的核心是 src/host/runtime.js（基类改由 deps 注入），fake-host
// 必须留在闭包外（C0.3 的完成判据是「无 dev/harness 的环境下 npm test 全绿」），所以工厂只造
// ctx、rt 由调用方决定。
export function fakeRuntime({ home = process.cwd(), config = {}, services = {}, create } = {}) {
  const host = fakeHost({ services, home })
  const mount = host.plugin(host.rootFiber, { name: 'miasaki-dsbot', inject: [...INJECTED_SERVICES], apply() {} })
  const ctx = mount.ctx
  const rt = create === undefined ? defaultRuntime(ctx, { home, config }) : create(ctx, config)
  return { host, ctx, rt, dispose: () => host.dispose() }
}

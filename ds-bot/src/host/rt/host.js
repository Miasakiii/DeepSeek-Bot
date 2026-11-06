// C0.2 契约层接口（rt.host）——src/host 对宿主（DSH）运行时的全部依赖面。
//
// 本文件是**接口成文**，不是实现：不含运行行为、不含 import（尤其禁止 import 任何 DSH 包，
// CI 守卫 scripts/check-dsh-imports.mjs 会扫 src/）。两个实现按它各自落地：
//   - src/host/rt/dsh.js      DSH 薄包装：把这里的每个成员转发到真实宿主对象；
//   - test/fake-host.js       契约 fake：按同一签名供给语义默认值（供 C0.3 的 L2 测试）。
// 挂载点是 index.js:48 的 inject 表、index.js:54 的 MODULES install(rt) 模式与
// index.js:82-103 的 createRuntime `rt` 对象（基线 docs/dev/2026-10-27-c0-execution-baseline.md §三 C0.2）。
// 正文是 JSDoc 契约；文末另附一份冻结的成员清单数据（HOST_CONTRACT，纯数据非行为），
// 两个实现按它逐面对账覆盖面。
//
// 语义只以行为锁定测试为准（dev/contract/ 下五个文件，对 dev/harness 里的真实包实测），
// 不照文档猜。引用写法 `dev/contract/<file>:<line>`；锁不到位的标 **未锁定** 并注原因。
// 范围纪律：只收 src/host 实际调用到的成员（实测口径见文首§0），不预先设计 DSH 全表面。
// 只被锁测试驱动、src/host 无调用点的成员统一收进§8「范围外」，不进契约本体。

// ============================================================================
// 0. 范围与读法
// ============================================================================

// 实测口径（2026-10-30，grep 自 src/host 含 browser/ 子目录与 index.js）：
//   ctx.* 共 255 处 / 41 文件；ctx.get 45 次 / 21 名；ctx.on 34 次注册 / 16 事件名；
//   ctx.effect 31 处；ctx.tools 31 处；ctx.inject 动态 4 处；connection 路由 2 条。
// 与基线 §2.2 口径一致（on 的 34 = 31 个静态调用点，其中 models.js:20 是一处四名循环）。
// 本文件的成员清单即按这个口径收敛；每节列出该面的调用点数以便回归比对。

// 服务的两种读法（契约根基，两个实现都必须复现）：
//   1) 属性读 `ctx.<name>`：只对 inject 声明过的服务可用，未注入时抛
//      "cannot get property \"<name>\" without inject"（dev/contract/services.test.js:147-170）。
//   2) `ctx.get('<name>')`：无 inject 要求，任何已 provide 的服务都可读；无人提供的名字
//      返回 undefined 且从不抛（dev/contract/services.test.js:134-145）。
// src/host 因此对可选服务以 ctx.get?.() 为主（45 次里 37 次）；inject 回退路径另有 8 次裸
// ctx.get(（parts.js:220/261 两处/265/266、secrets.js:574、schedules.js:81、tools.js:752）
// ——两个实现必须同时支持两种写法。对 8 个硬注入服务走属性读。

// DSH Service 实例每次读回都是新的可追踪代理：跨读比较服务对象或其方法身份没有意义
// （dev/contract/services.test.js:305-322）。普通 provide 的值则是同一对象（:317-321）。
// 两个实现都不得依赖「两次 get 返回同一引用」。

// ============================================================================
// 1. 服务面
// ============================================================================

/**
 * 插件上下文本体：src/host 的 41 个文件通过 install(rt) 拿到的 `rt.ctx`。
 * 八个 inject 服务以属性形式挂在上下文上（index.js:48），其余服务经 get/inject 读取。
 *
 * @typedef {object} HostContext
 * @property {(name: string) => any} get 见§0 读法 2；可选服务清单见§1.2。
 * @property {(names: string[], attach: (sub: HostContext) => void) => any} inject 动态注入，见§1.3。
 * @property {(name: string, listener: Function, options?: { prepend?: boolean }) => () => void} on 见§2。
 * @property {(body: Function, label?: string) => EffectDisposer} effect 见§4。
 * @property {(plugin: object, config?: any) => PluginFiber} plugin 挂载子插件，见§1.5。
 * @property {{ uid: number|null }} fiber 隐藏运行时态，见§5。
 * @property {{ info: Function, warn: Function }} logger 宿主日志；卸载后仍可用
 *   （dev/contract/tools-and-hidden.test.js:353）。src/host 用法：diagnostics.js:178、
 *   parts.js:615/749/1018。DSH 侧出处：cordis 上下文的 logger 属性（非注入服务）。
 * @property {LlmService} llm
 * @property {ToolsService} tools
 * @property {SystemPromptService} systemPrompt
 * @property {SessionControllerService} sessionController
 * @property {SessionsService} sessions
 * @property {SessionTitleService} sessionTitle
 * @property {WorkspaceRegistryService} workspaceRegistry
 * @property {ConnectionService} connection
 */

/** 挂载句柄：`await fiber.await()` 等插件就绪，`await fiber.dispose()` 卸载。
 *  uid 语义见§5。锁测试全程以这两个成员驱动真实挂载
 *  （dev/contract/services.test.js:47/272/273、dev/contract/events.test.js:687-696）。 */
/**
 * @typedef {object} PluginFiber
 * @property {() => Promise<any>} await
 * @property {() => Promise<any>} dispose
 * @property {number|null} uid
 */

// ---------------------------------------------------------------------------
// 1.1 inject 八服务（index.js:48）——属性读可用的硬依赖
// ---------------------------------------------------------------------------

/**
 * LLM 面。src/host 共 25 处 ctx.llm.* 调用：stream×9、resolveModelInfo×6、
 * listConfigurableProviders×5、registerAdapter×1、listProviders×2、listModels×1、
 * discoverModels×1；另 browser/session-model.js:154 是一处 `typeof ctx.llm?.resolveModelInfo`
 * 守卫、llm.js:4 是注释——原始 grep 的 27 行含这两项，不是调用。七个成员在真实 LlmRuntime
 * 上均为可调用（dev/contract/services.test.js:28/123-125）。
 *
 * @typedef {object} LlmService
 * @property {(options: any) => AsyncIterable<any>} stream
 *   发起一次模型流。返回**异步可迭代对象**（不是 Promise）；最外层 llm/stream 监听器
 *   决定返回形状——返回异步生成器就是生成器，声明 async 就包一层 Promise
 *   （dev/contract/events.test.js:521-540）。options 经中间件可被改写并到达适配器
 *   （dev/contract/events.test.js:542-559）。src/host 9 处调用：btw.js:163、images.js:95/189、
 *   memory.js:1255、parts.js:435/504/557、secrets.js:518、browser/session-model.js:175
 *   （groups.js:968、images.js:179、usage.js:579 是 llm/stream 事件注册，不是本成员）。
 *   DSH 侧出处：LlmRuntime 服务的 stream 成员；llm/stream 事件的 built-in 行为。
 *   chunk 数据形状（text-delta/usage/finish…）**未锁定**——锁测试只钉中间件行为。
 * @property {(provider: string, model: string) => Promise<any>} resolveModelInfo
 *   解析模型信息；src/host 只读 inputModalities 与 context。6 处调用：images.js:48、
 *   memory.js:1246、models.js:28、parts.js:240/553、browser/session-model.js:156；
 *   session-model.js:154 另有 typeof 守卫（成员不在函数位就退回「读图」默认）。
 *   返回结构**未锁定**。
 * @property {() => any[]} listConfigurableProviders
 *   可配置提供方条目；5 处：providers.js:60（与 settings/credentials 同时在位才算「可配置」
 *   的在位判定）与 providers.js:70/80/145/313（实调）。src/host 读 entry.provider /
 *   settingsNs / settingsPath / needsKey（needsKey 由 models.js:60 在条目上置，非调用点）。
 *   条目结构**未锁定**。
 * @property {(ids: string[], adapter: any) => AdapterHandle} registerAdapter
 *   注册自有适配器；返回句柄。src/host 唯一调用点 llm.js:826（llm.js:4 是注释）。
 *   句柄可调用（注销）且带 replace(ids) 换绑（llm.js:828）；注册与注销都会触发
 *   llm/adapters-updated（dev/contract/events.test.js:606-624）。「空 ids 的首次注册会被
 *   拒绝」只有 src/host 自注（llm.js:824）、**无锁测试支撑**，按本文纪律只作实现提示。
 * @property {() => { id: string }[]} listProviders
 *   已注册适配器的提供方列表；2 处：models.js:43、llm.js:812（带 ?. 守卫）。
 *   返回结构**未锁定**。
 * @property {(providerId: string) => Promise<any[]>} listModels（models.js:45）。返回结构**未锁定**。
 * @property {(provider: string, options?: any) => Promise<any[]>} discoverModels
 *   （providers.js:264）。返回结构**未锁定**。
 */

/** registerAdapter 的返回句柄。 */
/**
 * @typedef {object} AdapterHandle
 * @property {() => void} replace 换绑路由集合（src/host/llm.js:828）。
 * @property {() => void} 调用自身即注销（dev/contract/events.test.js:619-622）。
 */

/**
 * 工具注册面（§6 的宿主侧服务对象）。src/host 共 31 处 ctx.tools.*。
 * register/schemas/restrict/guard 四成员在真实 ToolRuntime 上可调用
 * （dev/contract/services.test.js:29/123-125）；execute/get 只有锁测试用，见§8。
 *
 * @typedef {object} ToolsService
 * @property {(tool: any) => () => void} register
 * @property {(agent?: any) => any[]} schemas
 * @property {(filter: { allow?: string[], deny?: string[] }) => () => void} restrict
 * @property {(guard: (exec: any) => string|undefined) => () => void} guard
 */

/**
 * 系统提示词面。src/host 2 处 ctx.systemPrompt.section（memory.js:1021、prompt.js:67），
 * 均写成 `ctx.effect(() => ctx.systemPrompt.section({...}))`——按 effect 契约
 * （dev/contract/effects.test.js:24-43）section 的返回值被当作 disposer 收取，但
 * **锁测试没有直接钉 section 的返回值**（services.test.js:30 只是 SERVICE_MEMBERS 表里
 * 的 `systemPrompt: ['section']` 一行）。section 入参 { name, order, interpolate,
 * text: (context) => string }。
 *
 * @typedef {object} SystemPromptService
 * @property {(section: any) => any} section
 */

/**
 * 会话控制面。src/host 共 11 处 ctx.sessionController.*（page×3、create×2、
 * selectModel/resolveAgent/prompt/projections/list/inspect 各 1）。
 * 八成员在真实 SessionController 上可调用（dev/contract/services.test.js:31/123-125）；
 * **各成员入参/返回结构一律未锁定**（锁测试只钉「真实活跃 + 可调用」）。
 * 调用点：agents.js:94、channel.js:422、chat-index.js:58、delivery.js:11、models.js:137、
 * parts.js:1287、resume.js:267、roster.js:87、usage.js:339/351/388。
 *
 * @typedef {object} SessionControllerService
 * @property {(query: any) => Promise<any>} page 分页读会话事件；chat-index.js:58 以
 *   { address: { kind: 'session', sessionId }, throughSeq, beforeSeq } 翻页。
 * @property {(place: any) => Promise<{ sessionId: string }>} create 建会话，返回 sessionId
 *   （agents.js:94、roster.js:87）。
 * @property {(request: any) => Promise<any>} selectModel 切模型，读 result?.selected
 *   （models.js:137-142）。
 * @property {(sessionId: string) => Promise<any>} resolveAgent 由 sessionId 得 Agent
 *   （delivery.js:11）。
 * @property {(body: any) => any} prompt（channel.js:422）。
 * @property {(query: any, signal?: AbortSignal) => Promise<any>} projections（usage.js:339）。
 * @property {(query: any, signal?: AbortSignal) => Promise<{ items?: any[] }>} list
 *   （usage.js:388 读 .items）。
 * @property {(sessionId: string, signal?: AbortSignal) => Promise<{ events?: any[] }>} inspect
 *   读会话持久日志；**可选成员**——resume.js:267 先做 typeof 检查再调，读 seen.events。
 */

/**
 * 会话存储面。src/host 共 10 处：flush×9（channel.js:381/406、delivery.js:101、
 * groups.js:800/926/943、images.js:203、parts.js:742/1001）与 messageProjections×1
 * （images.js:199）。flush 可调用、messageProjections 是对象（dev/contract/services.test.js:32/128）。
 *
 * @typedef {object} SessionsService
 * @property {(session: any) => Promise<any>} flush 把会话写回持久层（append 后调用）。
 * @property {{ type: string }[]} messageProjections 已注册的消息投影列表；images.js:199
 *   据此判断 image/offload 投影在不在（dev/contract/session-objects.test.js:333）。
 */

/**
 * 会话标题面。src/host 4 处 ctx.sessionTitle.rename（agents.js:157、roster.js:89/277/350），
 * 可调用（dev/contract/services.test.js:33）。入参/返回**未锁定**。
 *
 * @typedef {object} SessionTitleService
 * @property {(session: any, title: string) => Promise<any>} rename
 */

/**
 * 工作区注册面。src/host 共 21 处 ctx.workspaceRegistry.*（archiveSession×13、get×3、
 * resolveByPath×2、create×2、list×1）。五成员可调用（dev/contract/services.test.js:34/123-125）。
 * 调用点：agents.js:91/132/145/168、folders.js:23/126/179、groups.js:210、
 * parts.js:791/879/949、roster.js:55/61/203/417/549/618、store.js:396/406。
 * 入参/返回结构**未锁定**；调用点显示 archiveSession 收 (sessionId, { stopActivity })、
 * get 收 workspaceId 返回 { path }、create 收 (path, name)、list 返回数组。
 *
 * @typedef {object} WorkspaceRegistryService
 * @property {(sessionId: string, options?: { stopActivity?: boolean }) => Promise<any>} archiveSession
 * @property {(workspaceId: string) => any} get 可空选（folders.js:23 用 get?.()）。
 * @property {(path: string) => Promise<any>} resolveByPath
 * @property {(path: string, name: string) => Promise<any>} create
 * @property {() => any[]} list 可空选（folders.js:179 用 list?.()）。
 */

/**
 * 连接面。src/host 只用 fetch.register 2 条路由（channel.js:531、feed.js:104）；
 * fetch 是对象（dev/contract/services.test.js:129）。路由注册语义见§7。
 *
 * @typedef {object} ConnectionService
 * @property {{ register: (route: FetchRoute) => () => void }} fetch
 */

// ---------------------------------------------------------------------------
// 1.2 ctx.get 可选服务（21 名 / 45 次）——成员面只锁了一部分
// ---------------------------------------------------------------------------

// 存在性语义已锁：无人提供时 get 返回 undefined 且不抛
// （dev/contract/services.test.js:134-145）。**所有 21 个服务的成员形状默认未锁定**，
// 除非在 SERVICE_MEMBERS 表里被逐成员断言过（dev/contract/services.test.js:27-39）。
// 下面分组列出：A 组 = 锁测试断言过成员；B 组 = 仅存在性 + src/host 实测成员名。

/** A 组：锁测试在真实服务上断言过成员可调用/形状。 */

/**
 * 会话投影注册。动态 inject 目标之一（btw.js:71），另 5 处 ctx.get
 * （btw.js:74、channel.js:227、parts.js:1232、side.js:296、time-context.js:26）。
 * register/stateOf 可调用（dev/contract/services.test.js:35/182-183）。
 *
 * @typedef {object} SessionProjectionsService
 * @property {(projection: any) => any} register 注册投影（btw.js:71-73 的 anchorProjection）。
 * @property {(session: any, key: string) => any} stateOf 读某投影的折叠态
 *   （btw.js:79、time-context.js:26、session-objects.test.js:117 读 'inbox' 折叠态）。
 */

/** 定时任务面。动态 inject 目标（schedules.js:80）；catalog 可调用且新 home 返回 []
 *  （dev/contract/services.test.js:36/131/253-254）。src/host 读 entry.sessionId
 *  （schedules.js:96）。另三个成员只有 src/host 调用点、**成员面未锁定**：
 *  create/delete/list 见下。 */
/**
 * @typedef {object} ScheduleService
 * @property {() => Promise<any[]>} catalog
 * @property {(sessionId: string, request: any) => Promise<any>} create
 *   在某 Session 上建任务；schedules.js:116（schedule-create 端点，request 为
 *   { title, prompt, ...selectorOf(when) }）与 schedules.js:142（moveSchedules 把任务
 *   迁到新 part 时重建）。
 * @property {(query: { sessionId: string, id: any }) => Promise<any>} delete
 *   删任务；schedules.js:122（schedule-delete 端点）与 :143（迁移后删旧 part 上的）。
 * @property {(query: { sessionId: string }) => Promise<any[]>} list
 *   列某 Session 的任务；schedules.js:133，moveSchedules 读 record.id / record.title /
 *   requestOf(record)。
 */

/** shell 环境变量面。动态 inject 目标（secrets.js:572）；register 可调用
 *  （dev/contract/services.test.js:37）。src/host 以 { name, variables, resolve } 注册并收回
 *  注销函数（secrets.js:550-560）。 */
/**
 * @typedef {object} ShellEnvService
 * @property {(entry: any) => () => void} register
 */

/** 目标（goal）面。动态 inject 目标（tools.js:751）；get/block 可调用
 *  （dev/contract/services.test.js:38）。src/host 读 goal?.phase / goal.id / goal.revision
 *  后 block（tools.js:759-765）。 */
/**
 * @typedef {object} GoalsService
 * @property {(agent: any) => any} get
 * @property {(agent: any, goal: any, refusal: any) => any} block
 */

/**
 * 附件面。src/host 4 处 ctx.get?.('attachments') + 2 处 ctx.attachments 属性回退
 * （browser/session-model.js:42/44），成员 saveFile（delivery.js:130）、saveImages
 * （session-model.js:67/80）与 readFileStream（delivery.js:149）。
 * **成员面未锁定**：services.test.js 的 SERVICE_MEMBERS 表没有 attachments，只挂了真实
 * attachment-local 包（:61）未断言。
 */
/**
 * @typedef {object} AttachmentsService
 * @property {(entry: { data: Uint8Array, name: string }) => Promise<any>} saveFile
 * @property {(inputs: any[]) => Promise<any>} saveImages
 * @property {(file: any, signal?: AbortSignal) => AsyncIterable<Uint8Array>} readFileStream
 *   读回附件字节流；delivery.js:149 以 AbortSignal.timeout(HISTORY_TIMEOUT_MS) 读，
 *   TextDecoder 边收边解（fileText）。
 */

/**
 * 审批面。src/host 2 处 ctx.get?.('approval')（browser-plugins.js:69、folders.js:147），
 * 成员 request。request 的入参与 fail-closed 语义由真实 ApprovalService 锁定
 * （dev/contract/events.test.js:626-670）：入参 { agent, toolName, reason, callId, signal }，
 * 返回 'allowed-once' / 'rejected' / 'cancelled' / 'unavailable'；无人应答时链走完即
 * fail closed（:658）。approvals.js:48 另以 prepend 中间件在 approval/request 事件上作答。
 */
/**
 * @typedef {object} ApprovalService
 * @property {(request: any) => Promise<string>} request
 */

/** B 组：仅存在性已锁、成员名来自 src/host 实测（形状均未锁定）。 */
// - profileContext（browser.js:249、dsh-update.js:75、update.js:91）：读 .name、
//   .packageManager?.command、.dir。
// - pluginManager（dsh-update.js:81、update.js:75/88/116/235）：成员 registries()
//   （update.js:75，registryPlan 读 configured.registry / fallbackRegistries / resolved）、
//   listBundles()（update.js:88，installSpecOf 读 bundle.name / bundle.source）、
//   installBundle(spec, options)（update.js:235 在位判定、:253/:266 实调）。
// - loader（capabilities.js:245、connectors.js:77、dsh-update.js:50）：.import(specifier)
//   与 .unwrapExports?.(exports)；loader.import 挂载真实 MCP 客户端并随 fiber 卸载
//   （dev/contract/services.test.js:257-280）。
// - deepseekAccount（account.js:32/38/71）：.getState()、.startSignIn(meta, origin, kind)、
//   .cancelSignIn(id)、.signOut(meta)、.watch(signal)（异步可迭代）。
// - webServer（account.js:52）：.getOrigin()。
// - workingDirectory（folders.js:49、parts.js:1094）：.get(session)（可空选）。
// - agentDefaultModel（models.js:72/135）：.currentSelection?.()、.saveSelection(selection)。
// - compaction（parts.js:261/266）：压缩引擎对象，parts.js:298 的 effect 会整体换掉 .compact。
// - agentPresets（parts.js:261/265、roster.js:71）：.serviceFor(agent, kind)、.list()。
// - tokenMeter（parts.js:220）：.measure(session).totalTokens。
// - settings / credentials（providers.js:58/59）：settings.describe({ redactSecrets }) 与
//   settings.mutate(ns, ops, revision)（:67/:241）、credentials.describe(ref) / set(ref, key) /
//   unset(ref)（:106/181/192 等）；二者与 ctx.llm.listConfigurableProviders 同时在位才算「可配置」。
// - sandboxPolicy（folders.js:142）：.resolve() 与 .resolve({ session })，读 .mode。
// - permissionPresets（permissions.js:11）：.catalog() → { options, defaultPreset }、
//   .set(session, name)、.resolve(name)。
// - directoryPicker（folders.js:167）：.capability()（包 try/catch）。

// ---------------------------------------------------------------------------
// 1.3 动态 inject 四目标（ctx.inject）
// ---------------------------------------------------------------------------

// ctx.inject([name], attach) 的锁定语义（全部 dev/contract/services.test.js）：
//   - 等服务出现才执行 attach，晚到也能接上（:172-185）；
//   - 服务永不出现则 attach 永不执行、fiber.await() 正常落定（:187-196）；
//   - attach 收到的是**提供方自己的实例**（非代理副本），且不改外层作用域的读法（:198-217）；
//   - 同名第二次 inject 仍拿同一实例，互不覆盖（:210-216）；
//   - provide 方卸载时，attach 里注册的 effect disposer 随之释放，外层 get 变 undefined
//     （:219-238）。
// attach 形参是子上下文：带被注入服务属性 + effect（:184）。
// src/host 四个目标：sessionProjections（btw.js:71）、schedule（schedules.js:80）、
// shellEnv（secrets.js:572）、goals（tools.js:751）；四处都先 `typeof ctx.inject === 'function'`
// 守卫，否则回退 ctx.get + ctx.effect 手搓子上下文（如 tools.js:752、secrets.js:574、
// schedules.js:81、btw.js:74）——回退路径也属契约面，fake 必须同样支持。

// ---------------------------------------------------------------------------
// 1.4 插件挂载（ctx.plugin / agent.ctx.plugin）
// ---------------------------------------------------------------------------

// ctx.plugin(plugin, config?) → fiber；fiber.await() 等就绪、fiber.dispose() 卸载。
// 锁测试以真实挂载驱动（dev/contract/services.test.js:47/272-273、:288-295 的 skill 挂载、
// dev/contract/session-objects.test.js:265/271 的 agent.ctx.plugin）。
// src/host 用法：connectors.js:86（MCP 连接器挂到宿主 fiber）、capabilities.js:310
// （skill/MCP 挂到 **agent.ctx** fiber，随 Agent 卸载）。
// loader.import 拿到的插件对象同样走这个 API（services.test.js:269-273）。

// ============================================================================
// 2. 事件面与中间件顺序
// ============================================================================

/**
 * 事件总线面。src/host 共 34 次注册 / 16 个事件名（31 个静态调用点，其中 models.js:20
 * 一处循环注册 4 名）。注册顺序、中间件链与分发模式语义以 dev/contract/events.test.js 为准；
 * 逐事件名的锁定范围见本节末「未锁定」段。
 *
 * @typedef {object} EventBus
 * @property {(name: string, listener: Function, options?: { prepend?: boolean }) => () => void} on
 *   注册监听；返回卸载函数（events.test.js:258-259/676-680）。**监听器形参个数不决定形态**：
 *   分发模式由发射方选——emit 把实参原样传给每个监听器，waterfall 才把 next 追加为最后一个
 *   实参（cordis 源码 dev/harness/node_modules/@deepseek-ai/cordis/src/events.ts:194-243：
 *   emit 是 `cb(...args)`，waterfall 是 `args.push(next)` 后从最外层开始调）。因此 2 参监听
 *   在 emit 上是两个载荷实参——src/host 的 session/event 四例正是 (session, event)
 *   （feed.js:76、resume.js:179、turns.js:360、tools.js:765；锁测试 events.test.js:567-575
 *   同款用法并通过）——只有在 waterfall 上第二个形参才是 next（llm/stream、tools/execute、
 *   approval/request、system-prompt/assemble 等）。fake 若按形参个数判中间件会把这四例
 *   错判掉，与本节「分发模式是中间件语义一等公民」自相矛盾。
 * @property {(name: string, listener: Function) => void} once
 *   只触发一次（events.test.js:682-685）。src/host 无调用点（见§8）。
 */

// 顺序语义（锁测试钉死，fake 必须复现）：
//   - 默认按注册序，跨插件保持 MODULES 序（events.test.js:88-100）；
//   - `{ prepend: true }` 插到该事件**所有**已注册监听（含更早插件的）之前（:102-115）；
//   - 多个 prepend 后来者更靠前，默认监听永远排在所有 prepend 之后（:117-127）；
//   - 监听器所在插件 fiber 卸载时其监听一并移除（:687-696）。
// src/host 的 6 处 prepend：approvals.js:48、parts.js:1052/1109/1140/1151、time-context.js:45。
// 组合序实例：agent/pre-step 上 time-context（先装）与 parts（后装）都 prepend，
// 于是 parts 在最外层、先运行，随后 time-context、turns、usage（events.test.js:277-337）。

// 分发模式（dispatch mode）——中间件语义的一等公民：
//   - waterfall（异步、链式）：首注册者在最外层，返回值逐层向外组合；
//     `await next()` 等整条内链跑完（:129-148、:185-204）；
//     不调 next() 即消费事件，内链与 built-in 都不跑（:150-162）；
//     改 payload 对内层与 built-in 同时可见（同一对象）（:164-183）；
//     内层 throw 到达外层 `await next()` 可被捕获恢复（:206-223），无人恢复则整个
//     dispatch reject（:225-231）；无监听时落到 built-in（:274）。
//   - emit（同步、不等监听）：同步 throw 直接逃出并中止后续监听（:233-240）；
//     异步监听 rejection 无人接管，所以真实分发路径自己吞掉监听错误（:242-244 注、
//     :581-604 session/event 实证：后续监听照跑、append 不受影响、错误进 logger.warn）。
//   - bail / serial（通知模式）：无监听时返回 undefined（:272-273）。
// 模式由**发射方**（DSH 自己的分发点）选定，src/host 只注册、不选；监听器实参形态随模式定
// （emit 原样传参，waterfall 末位追加 next，见 EventBus.on 注）。cordis 的四个分发器实现：
// dev/harness/node_modules/@deepseek-ai/cordis/src/events.ts:194-243。
// emit/waterfall/bail/serial 本身不是 src/host 调用点（见§8），但**中间件语义依赖它们**，
// fake-host 必须实现（现状 test/fake-ctx.js:54-58 明确不跑中间件，是 C0.2 要补的缺口，
// 佐证：dev/contract/effects.test.js:92-102 记录了 fake 的 effect 缺口、同理由此及于事件面）。

// 16 个事件名与载荷（载荷形状仅列 src/host 实读字段；逐事件分发模式见下）：
//
// 核心 11（events.test.js:27-39）：
//   llm/stream        (options, next) — waterfall。options 实读：sessionId、purpose、
//                     messages、provider、model、tools（groups.js:987）、system
//                     （secrets.js:513）（groups.js:968-985、usage.js:579-600、secrets.js:510-518；
//                     signal 不在监听器里读——全仓 options.signal 只在 BotLlmAdapter 内部，
//                     llm.js:771/779）。真实 LlmRuntime 上：prepend 最先、veto 直接换掉适配器流
//                     （:466-502）、改写到达适配器（:542-559）、throw 呈给流的消费者
//                     （:504-519）、最外层监听决定 ctx.llm.stream() 的返回形状（:521-540）。
//   tools/execute     (exec, next) — waterfall。exec 实读：name、arguments、agent、callId、
//                     signal（secrets.js:489、tools.js:380）。真实 ToolRuntime 上：prepend
//                     最外层、链逆序展开（:339-362）；改写到达工具体、veto 让工具体不跑
//                     且中间件返回值要过工具自己的 output 校验（:364-390）；throw 变成结构化
//                     工具错误而不是 execute() reject（:392-410）；未知名也走完整链并原样
//                     带回结构化错误（:412-428）。
//   system-prompt/assemble (assembly, context, next) — waterfall。context.agent 实读
//                     （parts.js:1092）。真实 SystemPrompt 上：最外层监听器的返回值就是
//                     DSH 采用的 assembly（:430-446）、veto 整体替换（:448-464）。
//   approval/request  (request, next) — waterfall。request 实读：agent、toolName、reason、
//                     callId、signal（approvals.js:15-48）。真实审批服务上：prepend 先答、
//                     veto 跳过内置应答、throw fail closed 为 'unavailable'（:626-670）。
//   session/event     (session, event) — 同步通知（真实发射器上跑过：注册序、载荷深冻结、
//                     append 不受影响均已锁，:561-579/:581-604）。注意真实分发路径**自己容纳**
//                     监听错误——plain ctx.emit 会让同步 throw 逃出（:233-240），容错由 DSH
//                     的分发点负责、不由监听器负责。
//                     实读：event.type、event.seq、event.data（feed.js:76、resume.js:179、
//                     turns.js:360、tools.js:765）。
//   agent/created     ({ agent }) — 分发模式**未锁定**（src/host 以 1 参监听注册，运行期为
//                     通知形态；真实发射器未在 dev/contract 跑过）。src/host 四处：
//                     agents.js:70、capabilities.js:489、parts.js:308、tools.js:734。
//   agent/status      ({ agent, status }) — 分发模式**未锁定**（1 参监听）。status 实读
//                     'idle'/'running'（parts.js:1118；session-objects.test.js:289 实证取值集合）。
//                     四处注册（feed.js:72、images.js:193、memory.js:1711、parts.js:1198）。
//   agent/pre-step    (payload, next) — 分发模式**未锁定**：src/host 两处均以 (payload, next)
//                     注册（time-context.js:18、parts.js:1026），运行期确会收到 next；
//                     events.test.js:277-337 只是把本插件的注册模式（含 prepend 与 MODULES 序）
//                     搬到 ctx.waterfall 上验证组合序，没有跑真实 pre-step 发射器。
//                     payload 实读 agent、signal；decision.kind === 'reject' 即换 part
//                     （parts.js:1032/1039/1060/1066；events.test.js:296/317 的注释行号 1047
//                     已过时）。decision 的完整形状**未锁定**。
//   agent/request-error (payload, next) — 分发模式**未锁定**（src/host 两处均带 next 注册：
//                     parts.js:1124/1142）。payload 实读 failure.code、signal（parts.js:1125-1128）。
//   agent/assistant-stream ({ agent, frame }) — 分发模式与载荷形状均**未锁定**（feed.js:87）。
//   agent/inbox/discarded ({ message }) — 分发模式与载荷形状均**未锁定**（resume.js:169）。
//
// 可选 5（events.test.js:40-46；models.js:20 循环注册，全部无参监听）：
//   llm/adapters-updated — 同步通知（真实发射器上跑过：适配器注册/注销都触发、容纳抛错
//                     监听，:606-624）。src/host：llm.js:837、models.js:17/184。
//   credentials/reference-updated、credentials/record-updated、settings/document-updated、
//   deepseek-account/signed-out — 仅 models.js:20 的缓存失效监听。
//
// **未锁定（逐事件分发模式）**：上表 16 名中只有 6 名（llm/stream、tools/execute、
// system-prompt/assemble、approval/request、session/event、llm/adapters-updated）在真实
// 发射器上跑过；其余 10 名只锁了「总线级注册 + 派发可达 + 无名称校验」
// （events.test.js:253-275，文件头 :9-14 自述）。原因：它们需要真实 Agent（agent/* 六名）
// 或本文件未挂载的服务（credentials/*、settings/*、deepseek-account/*）。fake 对这 10 名
// 只需保证注册/派发/卸载与顺序语义，不必复现真实发射器的派发模式选择。

// ============================================================================
// 3. Agent/Session 对象面
// ============================================================================

// Agent 对象来自 agent/created 事件载荷与 sessionController.resolveAgent 的返回；
// Session 对象是 agent.session（另见 ctx.sessions，events.test.js:572 的 create 属测试驱动）。
// 本节语义除注明外锁定于 dev/contract/session-objects.test.js（真实 AgentRegistry +
// AgentLoop + ReactLoopAgent）；AgentContext.restrict 的两条拒绝语义另锁于
// tools-and-hidden.test.js:236-243；steer/inject/runMaintenance 三个成员无锁测（见下）。

/**
 * @typedef {object} AgentObject
 * @property {string} id 与 session.id 一致（session-objects.test.js:386）。
 * @property {any} session 该 Agent 的 Session（src/host 50 处 agent.session）。
 * @property {string} status 'idle' | 'running'（session-objects.test.js:139/179/191/289）。
 * @property {() => Promise<any>} whenIdle 等当前驱动空闲（parts.js:866、锁测试全程）。
 * @property {(message: any, list?: 'next-step'|'next-turn', wake?: boolean) => void} send
 *   投递输入；wake=false 只入队不唤醒，一个 wake 抽干整个待办队列
 *   （session-objects.test.js:146-180）。parts.js:774 的重投模式：只有第一条允许唤醒。
 * @property {(message: any) => void} followup
 *   排队到下一条 turn 并唤醒驱动，**返回前消息已被认领**（:182-199）；每条消息各自成 turn
 *   且持久 user/message 保留调用方给的 id 与 source（:201-214）。src/host 8 个调用点：
 *   channel.js:380/405、delivery.js:100、groups.js:796/922/939、parts.js:738/1000。
 * @property {(reason: any, options?: { keepInbox?: boolean }) => void} cancel
 *   取消待办；keepInbox 保留 inbox，否则清空（:216-227）。src/host 4 处：
 *   channel.js:501、groups.js:897、tools.js:286、turns.js:115。
 * @property {(input: any) => void} steer
 *   把消息切入**正在运行的 turn 的下一步**（delivery.js:90-91 注释：a steered message cuts
 *   into a running turn at its next step; a follow-up queues for the next turn）。
 *   src/host 1 处：delivery.js:99（steer 与 followup 二选一）。真实表面
 *   dev/harness/node_modules/@deepseek-ai/dsh-agent-loop/lib/types/agent.d.ts:42。
 *   **未锁定**：dev/contract 只锁了 send/followup/cancel，没有 steer 的锁测。
 * @property {(input: any) => void} inject
 *   重投路径的另一半：parts.js:738-739 按 source.kind 分流——user/SOURCE_KIND/REPLY_KIND
 *   走 followup，其余走 inject。src/host 1 处：parts.js:739。真实表面 agent.d.ts:43。
 *   **未锁定**（无锁测）。
 * @property {<T>(job: (signal: AbortSignal) => Promise<T>) => Promise<T>} runMaintenance
 *   在 Agent 的维护窗口跑一段作业。src/host 1 处：parts.js:869（runSwitch：先 whenIdle，
 *   再 runMaintenance(signal => moveOn(...))，期间到达的输入留在旧 part 的 inbox）。
 *   真实表面 agent.d.ts:45。**未锁定**（无锁测）。
 * @property {AgentInbox} inbox
 * @property {HostContext} ctx Agent 作用域的上下文，见本节 AgentContext。
 */

/**
 * 持久收件箱：两个命名列表，读写都是日志里的持久 splice
 * （session-objects.test.js:81-104）。src/host 29 处 inbox 成员访问（本次 grep 实测；
 * 基线 §2.2 记 26 处，口径略差），集中在 parts.js / turns.js / groups.js / resume.js /
 * tools.js。
 *
 * @typedef {object} AgentInbox
 * @property {any[]} nextStep 下一步队列；计算键访问同样有效（:73-76，groups.js:415 依赖）。
 * @property {any[]} nextTurn 下一轮队列。
 * @property {(list: 'next-step'|'next-turn', message: any) => void} prepend
 *   插到本列表头部；持久 splice 且**不唤醒驱动**（:81-104、:136-144）。
 *   src/host 仅 parts.js:763 一处。
 * @property {(messageId: string) => boolean} remove
 *   按 id 移除，返回是否曾在队列；活列表与持久 inbox 投影随后一致（:106-119）。
 *   src/host 5 处直接调用（groups.js:434、parts.js:773/790/1009、turns.js:119）加
 *   tools.js:230 的可空选调用。
 */

// 锁测试另钉但 src/host 无调用点的 inbox 成员（fake 可实现可不实现，契约不强制）：
// append（:81-104）、clear（:121-134，先 next-step 后 next-turn）、hasPending（:77/129）。

/**
 * Agent 作用域上下文：src/host 只用 restrict/effect/plugin 三个成员（8 处：
 * agents.js:56/61、capabilities.js:310/423/426、tools.js:715/721）；贡献随 Agent 拆卸
 * （session-objects.test.js:260-272），监听按 Agent 过滤（:274-292，仅锁测试驱动），
 * 工具限制不外溢到根（:229-258）。
 */
/**
 * @typedef {object} AgentContext
 * @property {(filter: { allow?: string[], deny?: string[] }) => () => void} restrict
 *   tools.restrict 的作用域形态。已锁（session-objects.test.js:229-258，真实 Agent 上）：
 *   deny 只影响本 Agent 的 schemas 与执行（:243-255）、未知全局名抛错（:257）。
 *   另两条拒绝语义锁在 tools-and-hidden.test.js:236-243（真实 ToolRuntime，非 Agent 面）：
 *   空过滤 /tools\.restrict\(\{\}\) is a no-op/（:240）、根上下文调用
 *   /requires a scoped context \(agent\.ctx\)/（:242）。
 * @property {(body: Function, label?: string) => EffectDisposer} effect
 *   随 Agent 卸载；Agent 拆后再注册抛 inactive-context（:260-272）。
 * @property {(plugin: object, config?: any) => PluginFiber} plugin（:265/271）。
 */

/**
 * Session 对象（agent.session）。src/host 实读：id、seq、eventAt、append、header、
 * requestHeader()、deriveMessages。
 *
 * @typedef {object} SessionObject
 * @property {string} id
 * @property {number} seq 日志长度；seq-1 是最后一条已提交事件（:361-379）。
 *   chat-index.js:55 的 throughSeq = Number(seq) - 1、:148 的 gap 校验即基于此。
 * @property {(seq: number) => any} eventAt 按序号取事件（:304/308/374）。
 *   btw.js:64 注明该成员对新调用者关闭——src/host 现存两处（images.js:16、parts.js:1180，
 *   后者带 ?. 守卫）。
 * @property {(type: string, data: any, options?: { surfaceOp?: any, sourceEventSeqs?: number[] }) => any} append
 *   追加事件并返回已提交事件；seq 恰增一（:294-309）。契约校验（两侧都抛）：
 *   产消息事件必须声明 surfaceOp、纯日志事件不得声明、sourceEventSeqs 显式空数组拒绝
 *   （:311-324）；image/offload 只在对应投影已注册时被接受，且拒绝时日志不变（:326-339）。
 *   src/host 唯一调用点 images.js:202。
 * @property {object} header 冻结记录：version、id、cwd、isSeeded、createdAt（:381-393）；
 *   写字段抛 read only（:392）。实读 cwd（folders.js:49、parts.js:991/992/1075）。
 * @property {() => any} requestHeader
 *   无 header 事件时返回 undefined，之后折叠到最新一个且**返回缓存值**
 *   （:395-416）；实读 .config（parts.js:238/425/495/545/890、btw.js:143、
 *   browser/session-model.js:19）。src/host 7 处调用，另 session-model.js:14 有 typeof 守卫。
 * @property {() => any[]} deriveMessages
 *   每次返回新数组、元素是共享的冻结消息（:418-439）；跟随 surface 替换而非原始日志
 *   （:441-456）。src/host 6 处：btw.js:144、parts.js:228/428/501/562/910。
 */

// ============================================================================
// 4. effect/dispose 生命周期
// ============================================================================

/**
 * ctx.effect(body, label?) 的返回：既可调用（立即处置）又是 thenable（await 它只等
 * body 落定、不处置）。全部语义锁定于 dev/contract/effects.test.js。
 * src/host 31 处 ctx.effect / 24 文件。
 *
 * @typedef {object} EffectDisposer
 * @property {() => Promise<any>} 调用即处置该 effect；幂等，二次调用拿到同一在途处置
 *   （effects.test.js:145-156）。
 * @property {() => Promise<any>} then await 不等同于处置（:158-163）。
 * @property {string} [Context.effect] 挂载点上的 label 元数据（:38、:50 默认 'anonymous'）。
 */

// 契约语义（fake 必须逐条复现；现状 test/fake-ctx.js:60-68 只支持同步 disposer，
// 其缺口由 effects.test.js:92-102 实证记录）：
//   - body 在注册时立即跑（:33）；返回 undefined/null 表示无需清理，不是错误（:33、:48-50）；
//   - body 返回非 disposer 值抛 TypeError 'Invalid effect'（:51）；
//   - body 可返回 disposer、**返回 Promise<disposer>**（兑现时收取，:72-90）、或返回
//     生成器依次产出多个 disposer（:123-143）；
//   - 处置顺序 = 注册逆序；所有 disposer 先启动、再有谁完成，unload 等最慢的一个
//     （:54-70、:104-121）；一个 effect 的多个 disposer 也逆序、串行（:123-143）；
//   - disposer 返回 Promise 时 unload 一直敞开等它落定（:54-70）；
//   - 已提前处置的 effect 不在 unload 时二次处置（:156）；
//   - 嵌套上下文上的 effect 随该上下文及其父上下文一起走（:214-248）；
//   - unload 后注册抛 INACTIVE_EFFECT 'cannot create effect on inactive context'（:166-178）。
// 「不清会坏」的 7 处关键 disposer 作为契约用例（基线 §2.2，逐一在 effects.test.js:184-343
// 以同构模式锁定）：store.js:336（状态锁等在写写入并拒绝其后写入）、
// capabilities.js:426（Agent 域 effect 随 Agent 与父域）、capabilities.js:499（启动遗留
// 不等待、异步 disposer 要等）、parts.js:298（同步 disposer 还原被打的补丁）、
// diagnostics.js:125（停止标志先于排队写落定）、resume.js:386（unload 清定时器并等写链）、
// usage.js:274 与 chat-index.js:127（同步 disposer 关资源；抛错的关资源不影响 unload）。

// ============================================================================
// 5. 隐藏运行时态
// ============================================================================

// src/host 唯一直接读的隐藏态是 ctx.fiber（parts.js:748 一处）。锁定语义：
//   - ctx.fiber.uid：根 fiber 为 0，存活插件为正整数，卸载后为 null；
//     且 **uid 在卸载 disposer 运行之前就被清掉**（tools-and-hidden.test.js:292-311）；
//   - 卸载后上下文的两条 observable 错误形态（:314-347）：
//       服务查找 → 'cannot get required service "tools" in inactive context'
//         （含 "in inactive context" 字样）；
//       新建 effect / 注册监听 → 'cannot create effect on inactive context'
//         （INACTIVE_EFFECT，**不含**该字样，:341-347、effects.test.js:179-181 自述）；
//   - unload disposer 内部服务仍可读、logger 仍可用（:352-353）。
// parts.js:748 的等价谓词即由此两面合成：
//   const unloaded = error => ctx.fiber?.uid === null || /in inactive context/.test(String(error?.message ?? error))
// 契约把它表达为「卸载期错误」谓词，两个实现各自给出等价的 uid/错误消息，不复刻 cordis 内部。

/**
 * 卸载期判定谓词：宿主上下文（或 agent.ctx）在插件卸载后对服务读取与新建贡献报错，
 * 且 fiber.uid 已置 null。src/host 用法：parts.js:748。
 *
 * @typedef {(error: any) => boolean} UnloadedPredicate
 */

// ============================================================================
// 6. 工具注册面
// ============================================================================

// 见§1.1 ToolsService 的 typedef；此处补全局（非 agent 域）语义，全部锁定于
// dev/contract/tools-and-hidden.test.js：
//   register(tool)（src/host 26 处：tools.js、groups.js、memory.js、secrets.js、
//     browser.js、browser-plugins.js、browser/mount.js 等）
//     - 返回的 disposer 把工具从 schemas 与执行面同时摘掉（:142-152）；
//     - 注册归属**发起注册的 fiber**：插件域注册随该插件卸载消失（:155-165）；
//     - 拒绝：重名（:171）、保留名 run_code（:172）、缺 output 契约的 definition（:173-176）。
//   schemas(agent?)（src/host 2 处：agents.js:52、tools.js:718）
//     - 只投影面向模型的字段（name/description/parameters），无 execute/output 回调（:120-125）；
//     - 每次读回都是**新的深拷贝**，调用方改它不影响注册定义与下一次读（:127-131）；
//     - 传 agent 得该 agent 的可见面；未限制过的 agent 与全局视图一致（:179-189）。
//   restrict({allow?,deny?})（src/host 2 处：agents.js:61、tools.js:721，均在 agent.ctx 上）
//     - 只收窄继承的全局工具；deny 命中的工具在 schemas 与执行中都读作「不存在」
//       （UNKNOWN_TOOL，而非「被拒绝」）（:191-217）；
//     - allow 与 deny 可组合（交集）；作用域自己的注册不受自己限制约束，也不能被过滤器
//       点名（:219-234）；
//     - 拒绝：空过滤（:240）、未知全局名（:241）、在根上下文调用（:242）；
//     - 返回 lift 函数解除限制（:213-214）。
//   guard(fn)（src/host 1 处：tools.js:730，拦 ask_user_question 类工具）
//     - 在工具体之前判定；fn 收到 exec（含 name、agent——同一 Agent 身份、arguments 冻结），
//       返回字符串即拒绝、undefined 放行（:245-276）；
//     - 多个 guard 按注册序跑、第一个拒绝生效、后续 guard 不被触达（:278-290）；
//     - 返回 lift 函数解除（:273-275）。
//     「任何 guard 都不能强制放行」是从 string|undefined 返回类型推出的**推断，无专测**：
//     :278-290 里没有任何 guard 尝试放行，锁测试只证明了顺序与首个拒绝生效。
// execute/get 只有锁测试驱动（见§8）。

// ============================================================================
// 7. connection 路由面
// ============================================================================

// src/host 只用 ctx.connection.fetch.register 两条精确 Fetch 路由（基线 §C0.2「connection
// 路由面」）：channel.js:531 的 ROUTE='/api/bot'（POST，src/host/constants.js）与
// feed.js:104 的 FEED_ROUTE='/api/bot/feed'（GET，src/host/feed.js）。均以 ctx.effect
// 包装，effect 的 disposer 即路由的卸载。语义锁定于 dev/contract/tools-and-hidden.test.js:356-468。
/**
 * @typedef {object} FetchRoute
 * @property {string} path 精确路径，必须以 '/api' 打头且不含 '..'（:449-450）。
 * @property {string[]} methods 非空、不重复（:451-452）。
 * @property {'buffered'} requestBody 桥接方读体前先问的模式；未覆盖路径默认同为 buffered
 *   （:398-402）。
 * @property {(request: Request) => Promise<Response>} fetch 路由处理。
 */

// 锁定语义：
//   - 精确路由先于共享 RPC 通道被服务，未覆盖的落到共享通道（:405-443）；
//   - 路由归属注册它的 fiber：effect 处置后路径重新落回共享通道（:433-441）；
//   - 注册表校验形状、拒绝重复路径（冲突在 effect 运行时才 surface，:454-458）；
//   - 非 owner peer 的请求得 403（:464-467）；路由不声明的方法与未覆盖路径得 404
//     （:429-431、:461-463）。
// 锁测试为驱动路由另用了 createSharedFetchHandler('/api')、browserPeer、rpc.intercept、
// createPeer（:384-442、:464）——src/host 无调用点，见§8。

// ============================================================================
// 8. 范围外（明确不进本契约，附原因）
// ============================================================================

// 1) src/host/browser/ 下的 ctx.session.*（refs.js 14 处、script.js 2 行 4 次访问、task.js 1 处）
//    与 ctx.complete（task.js:49）：这是本插件**自有**的浏览器会话对象
//    （browser/mount.js:75 的 openBotBrowser 造，mount.js:99-104 手工塞进工具执行上下文），
//    不是宿主提供的面，无锁测试也不该有——留待浏览器切片自己成文。
// 1b) agent.ctx.on（session-objects.test.js:283-284）与 agent.ctx.tools.register
//    （tools-and-hidden.test.js:231）：只被锁测试驱动、src/host 无调用点——§3 的
//    AgentContext 因此只列 restrict/effect/plugin 三个成员；fake 若要让 L2 测试跑到这两条
//    路径需自备，契约不强制。
// 2) ctx.agents / ctx.approval / ctx.skills 等属性读：src/host 零调用点；锁测试用它们
//    搭建真实环境（session-objects.test.js:61、events.test.js:630-642、services.test.js:287-295）。
// 3) ctx.emit：src/host 不直接调，但包装面仍转发它（rt/dsh.js）——锁测试要经包装发射来
//    对账 on 的顺序/prepend/传参（rt-dsh-reconciliation.test.js:312-327）。ctx.waterfall /
//    ctx.bail / ctx.serial / ctx.once：src/host 无调用点，包装面也不转发（reconciliation
//    钉住 name in host === false）。§2 已把分发模式作为中间件依存的语义钉住，fake 必须实现。
// 4) ctx.tools.execute / ctx.tools.get：锁测试驱动注册表用（services.test.js:275、
//    tools-and-hidden.test.js:126/133/148/202-215）；src/host 无调用点。fake 若要让 L2
//    测试执行工具需自备，契约不强制其形状。
// 5) connection.createSharedFetchHandler / browserPeer / rpc.intercept / createPeer：
//    锁测试驱动路由用（tools-and-hidden.test.js:384-467）；src/host 只用 fetch.register。
// 6) session.snapshotEvents：锁测试读日志用（session-objects.test.js:95/130/176/207/224/
//    330/345/371/455）；src/host 不调（走 sessionController.page / inspect 与 eventAt）。
// 7) agent.inbox.append / clear / hasPending：锁测试钉了（session-objects.test.js:81-134），
//    src/host 不调。

// ============================================================================
// 附录：契约成员清单（数据）
// ============================================================================

// 上方 JSDoc 是语义与逐成员锁定引用的正本；本清单是成员名的机器可读索引，rt/dsh.js 与
// test/fake-host.js 按它逐面对账（实现一个面、勾掉一个面）。名字按 src/host 实测调用面收，
// 锁测试驱动、src/host 无调用点的成员不在表内（见§8）。
export const HOST_CONTRACT = Object.freeze({
  // 服务面：属性读可用的 8 个硬注入服务（index.js:48），成员见§1.1 各 typedef。
  injectedServices: Object.freeze(['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']),
  // 服务面：ctx.get 读取的可选服务（21 名 / 45 次），成员注释见§1.2。
  optionalServices: Object.freeze([
    'agentDefaultModel', 'agentPresets', 'approval', 'attachments', 'compaction', 'credentials',
    'deepseekAccount', 'directoryPicker', 'goals', 'loader', 'permissionPresets', 'pluginManager',
    'profileContext', 'sandboxPolicy', 'schedule', 'sessionProjections', 'settings', 'shellEnv',
    'tokenMeter', 'webServer', 'workingDirectory',
  ]),
  // 服务面：ctx.inject 动态注入目标（4 处调用点）。
  dynamicInject: Object.freeze(['sessionProjections', 'schedule', 'shellEnv', 'goals']),
  // 事件面：16 个事件名（11 核心 + 5 可选，34 次注册）。
  events: Object.freeze({
    core: Object.freeze(['llm/stream', 'session/event', 'agent/created', 'agent/status', 'agent/pre-step', 'agent/request-error', 'tools/execute', 'approval/request', 'system-prompt/assemble', 'agent/assistant-stream', 'agent/inbox/discarded']),
    optional: Object.freeze(['llm/adapters-updated', 'credentials/reference-updated', 'credentials/record-updated', 'settings/document-updated', 'deepseek-account/signed-out']),
    // 逐事件分发模式已锁的 6 名；其余 10 名只锁总线级注册与派达（events.test.js:9-14）。
    dispatchLocked: Object.freeze(['llm/stream', 'tools/execute', 'system-prompt/assemble', 'approval/request', 'session/event', 'llm/adapters-updated']),
  }),
  // 对象面：Agent / inbox / Session 成员（签名与语义见§3 各 typedef）。
  agent: Object.freeze(['id', 'session', 'status', 'whenIdle', 'send', 'followup', 'steer', 'inject', 'cancel', 'runMaintenance', 'inbox', 'ctx']),
  inbox: Object.freeze(['nextStep', 'nextTurn', 'prepend', 'remove']),
  session: Object.freeze(['id', 'seq', 'eventAt', 'append', 'header', 'requestHeader', 'deriveMessages']),
  // 服务面：可选服务的成员索引（与§1.2 注释一一对应）。除 catalog（services.test.js:131/254）、
  // request（events.test.js:626-670）、sessionProjections.register/stateOf（:182-183）、
  // shellEnv.register、goals.get/block、loader.import/unwrapExports（:257-280）外，
  // 其余成员名来自 src/host 实测、形状均未锁定。
  optionalServiceMembers: Object.freeze({
    schedule: Object.freeze(['catalog', 'create', 'delete', 'list']),
    attachments: Object.freeze(['saveFile', 'saveImages', 'readFileStream']),
    approval: Object.freeze(['request']),
    sessionProjections: Object.freeze(['register', 'stateOf']),
    shellEnv: Object.freeze(['register']),
    goals: Object.freeze(['get', 'block']),
    loader: Object.freeze(['import', 'unwrapExports']),
    pluginManager: Object.freeze(['registries', 'listBundles', 'installBundle']),
    profileContext: Object.freeze(['name', 'packageManager', 'dir']),
    deepseekAccount: Object.freeze(['getState', 'startSignIn', 'cancelSignIn', 'signOut', 'watch']),
    webServer: Object.freeze(['getOrigin']),
    workingDirectory: Object.freeze(['get']),
    agentDefaultModel: Object.freeze(['currentSelection', 'saveSelection']),
    agentPresets: Object.freeze(['serviceFor', 'list']),
    compaction: Object.freeze(['compact']),
    tokenMeter: Object.freeze(['measure']),
    settings: Object.freeze(['describe', 'mutate']),
    credentials: Object.freeze(['describe', 'set', 'unset']),
    sandboxPolicy: Object.freeze(['resolve']),
    permissionPresets: Object.freeze(['catalog', 'set', 'resolve']),
    directoryPicker: Object.freeze(['capability']),
  }),
  // effect 面：ctx.effect(body, label?) → EffectDisposer，语义见§4。
  effect: Object.freeze(['ctx.effect', 'EffectDisposer']),
  // 隐藏态：ctx.fiber.uid 与卸载期谓词，语义见§5。
  hiddenState: Object.freeze(['ctx.fiber.uid', 'unloaded predicate']),
  // 工具面：ctx.tools 四成员，语义见§6。
  tools: Object.freeze(['register', 'schemas', 'restrict', 'guard']),
  // 连接面：ctx.connection.fetch.register 与路由形状，语义见§7。
  connection: Object.freeze(['fetch.register']),
})

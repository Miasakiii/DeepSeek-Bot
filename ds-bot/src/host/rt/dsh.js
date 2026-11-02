// C0.2 契约层实现：src/host/rt/host.js 的 DSH 落地——把契约的每个面转发到真实宿主对象。
//
// 纪律（host.js 文首与 AGENTS.md「Build on DSH」）：
//   - 薄：只转发，不加语义。每个成员的注释引用钉住它的锁测试 `dev/contract/<file>:<line>`；
//     语义未锁定的按 host.js 的标注原文转发，不补默认值、不改形状。
//   - 不 import 任何 @deepseek-ai/*：本文件只用 node 内置模块（这里一个都不需要），
//     CI 守卫 scripts/check-dsh-imports.mjs 扫 src/，唯一例外是 llm-dsh.js。
//   - 服务每次读都读穿：DSH Service 每次读回都是新的可追踪代理，跨读比较服务对象或其方法
//     身份没有意义（dev/contract/services.test.js:305-322），所以下面的服务一律写成 getter，
//     现读 ctx，不把服务对象存进闭包长期复用。
//
// 名字：createHost(ctx) 对应 host.js 的 `HostContext` typedef，与 index.js:82 的 createRuntime
// 同级（将来由 createRuntime 把拿到的 ctx 交给它包一层；本轮不改 index.js）。返回的不是新
// 上下文，而是同一个宿主上下文的读穿面。
//
// 未列入本面的名字在包装对象上读作 undefined：src/host 对可选服务一律走 ctx.get?.()
// （host.js §0 读法 2），唯一的属性回退是 attachments（browser/session-model.js:42/44），
// 已按 §1.2 转发。host.js §8 明确排除的面（ctx.session / ctx.complete 是本插件自有的浏览器
// 工具执行上下文，ctx.agents / approval / skills、ctx.waterfall / bail / serial / once 等）
// 不进这里；其中 emit 按本轮任务要求转发，见下。

// 上下文本面：host.js §1 服务面、§2 事件面、§4 effect、§5 隐藏态、§6 工具面、§7 连接面。
// agent.ctx 是同一个形状（真实 DSH 里它也是一个完整 Context，见§3 AgentContext 注），
// 所以 createHost 与 agentView(...).ctx 共用这一个工厂。
function contextView(ctx) {
  return {
    // --- §1.1 八个 inject 服务（index.js:48）---------------------------------------
    // 属性读只对 inject 声明过的服务可用，未注入时抛
    // 'cannot get property "<name>" without inject'（dev/contract/services.test.js:147-170）；
    // getter 现读 ctx.llm 正是为了把这个抛掷原样带给调用方。
    // LLM 面七成员：dev/contract/services.test.js:28（SERVICE_MEMBERS 表）与 :123-125
    // （真实 LlmRuntime 上均可调用）；chunk 与返回结构未锁定（host.js §1.1）。
    get llm() { return ctx.llm },
    // register/schemas/restrict/guard：dev/contract/services.test.js:29/123-125，
    // 逐条语义 dev/contract/tools-and-hidden.test.js:113-290。
    get tools() { return ctx.tools },
    // section：dev/contract/services.test.js:30（表内一行）；锁测试没有直接钉它的返回值
    // （host.js §1.1 SystemPromptService 注）。
    get systemPrompt() { return ctx.systemPrompt },
    // 八成员：dev/contract/services.test.js:31/123-125；入参/返回结构一律未锁定
    // （host.js §1.1 SessionControllerService 注）。
    get sessionController() { return ctx.sessionController },
    // flush 可调用、messageProjections 是对象：dev/contract/services.test.js:32/128；
    // images.js:199 据 messageProjections 判断 image/offload 投影在不在
    // （dev/contract/session-objects.test.js:333）。
    get sessions() { return ctx.sessions },
    // rename：dev/contract/services.test.js:33；入参/返回未锁定（host.js §1.1）。
    get sessionTitle() { return ctx.sessionTitle },
    // 五成员：dev/contract/services.test.js:34/123-125；入参/返回结构未锁定（host.js §1.1）。
    get workspaceRegistry() { return ctx.workspaceRegistry },
    // fetch 是对象：dev/contract/services.test.js:129；两条精确路由的注册语义
    // dev/contract/tools-and-hidden.test.js:356-468。
    get connection() { return ctx.connection },

    // --- §1.2 ctx.get 可选服务 ------------------------------------------------------
    // 读法 2：无 inject 要求，任何已 provide 的服务都可读，无人提供的名字返回 undefined
    // 且从不抛（dev/contract/services.test.js:134-145）。src/host 45 次里 37 次是这个写法
    // （host.js §0）。
    get(name) { return ctx.get(name) },

    // --- §1.3 动态 inject -----------------------------------------------------------
    // 等服务出现才执行 attach，晚到也能接上；永不出现则 attach 永不执行、fiber.await() 正常
    // 落定（dev/contract/services.test.js:172-196）。attach 收到的是**提供方自己的实例**，
    // 同名第二次 inject 仍拿同一实例（:198-217）——所以 attach 原样透传，不包子上下文，
    // 一包就破坏 :208 的实例同一性。provide 方卸载时 attach 里注册的 effect disposer 随之
    // 释放（:219-238）。
    inject(names, attach) { return ctx.inject(names, attach) },

    // --- §1.4 插件挂载 --------------------------------------------------------------
    // 返回宿主 fiber：`await fiber.await()` 等就绪、`await fiber.dispose()` 卸载
    // （dev/contract/services.test.js:47/272-273、dev/contract/session-objects.test.js:265/271
    // 的 agent.ctx.plugin）。fiber.uid 的语义见§5。
    plugin(plugin, config) { return ctx.plugin(plugin, config) },

    // --- §2 事件面 ------------------------------------------------------------------
    // 注册返回卸载函数（dev/contract/events.test.js:258-259）；默认按注册序、跨插件保持
    // MODULES 序（:88-100），{ prepend: true } 插到该事件所有已注册监听之前、多个 prepend
    // 后来者更靠前（:102-127）；监听器所在 fiber 卸载时其监听一并移除（:687-696）。
    // 分发模式由发射方选：emit 原样传参，waterfall 才把 next 追加为最后一个实参
    // （host.js §2 EventBus.on 注），所以监听器形参个数不决定形态。
    on(name, listener, options) { return ctx.on(name, listener, options) },
    // host.js §8-3：src/host 没有 emit 调用点，转发它只为让锁测试经包装发射、对账 on 的
    // 顺序/prepend/传参（rt-dsh-reconciliation.test.js:312-327）。同步监听抛错会直接逃出并
    // 中止后续监听、异步 rejection 无人接管（dev/contract/events.test.js:233-244），容错由
    // DSH 自己的分发点负责（:581-604 的 session/event 实证）。原样传参，不追加 next。
    emit(name, ...args) { return ctx.emit(name, ...args) },

    // --- §4 effect ------------------------------------------------------------------
    // 返回的 EffectDisposer 既可调用（立即处置、幂等，二次调用拿到同一在途处置）又是
    // thenable（await 它只等 body 落定、不处置）：dev/contract/effects.test.js:24-43、
    // :145-164；body 返回非 disposer 值抛 TypeError 'Invalid effect'（:51）。
    effect(body, label) { return ctx.effect(body, label) },

    // --- §5 隐藏运行时态 ------------------------------------------------------------
    // ctx.fiber.uid：根 fiber 为 0，存活插件为正整数，卸载后为 null，且 uid 在卸载 disposer
    // 运行之前就被清掉（dev/contract/tools-and-hidden.test.js:292-311）。src/host 只在
    // parts.js:748 读它，与错误消息合成「卸载期」谓词（host.js §5）；谓词由调用方拼，
    // 这里只负责把真实的 fiber 交出去。
    get fiber() { return ctx.fiber },

    // --- §1 宿主日志 ----------------------------------------------------------------
    // host.js §1 HostContext.logger：非注入服务，卸载后仍可用
    // （dev/contract/tools-and-hidden.test.js:352-353）。src/host：diagnostics.js:178、
    // parts.js:615/749/1018。
    get logger() { return ctx.logger },

    // --- §1.2 attachments 的属性回退 ------------------------------------------------
    // 附件面成员面**未锁定**（host.js §1.2：services.test.js 的 SERVICE_MEMBERS 表没有
    // attachments，只挂了真实 attachment-local 包未断言）。src/host 以 ctx.get?.() 为主，
    // 另有两处属性回退（browser/session-model.js:42/44），所以这里也把属性读透传下去：
    // 名字无人提供时读作 undefined，被 provide 而未 inject 时抛掷，都与真实 ctx 一致。
    get attachments() { return ctx.attachments },
  }
}

// 把 apply(ctx) 拿到的宿主上下文包成 host.js §1-§7 的读穿面。src/host 的 install(rt) 将来
// 通过它拿 `rt.ctx`（挂载点 index.js:82-103 的 createRuntime）。
export function createHost(ctx) {
  return contextView(ctx)
}

// ----------------------------------------------------------------------------
// §3 Agent 对象面（host.js §3 AgentObject）
// ----------------------------------------------------------------------------

// Agent 来自 agent/created 事件载荷与 sessionController.resolveAgent 的返回；包装只转发，
// 调用方显式包（host.js §3）。`session` 直接返回真实 Session 而不包 sessionView：DSH 的
// 会话存储按对象身份认 Session（dsh-session lib/index.js:1965-1969 的
// `attachments.get(session)`， WeakMap 查找），而 src/host 的 9 处
// `ctx.sessions.flush(agent.session)`（channel.js:381/406、delivery.js:101、groups.js:800/
// 926/943、images.js:203、parts.js:742/1001）会把 agent.session 原样传回宿主，包一层就
// 认不出来了。
export function agentView(agent) {
  return {
    // 与 session.id 一致：dev/contract/session-objects.test.js:386。
    get id() { return agent.id },
    // 该 Agent 的 Session（src/host 50 处 agent.session）；返回真实对象，见上。
    get session() { return agent.session },
    // 'idle' | 'running'：dev/contract/session-objects.test.js:139/179/191/289。
    get status() { return agent.status },
    // 等当前驱动空闲（parts.js:866）：dev/contract/session-objects.test.js:141/165/195/205。
    whenIdle() { return agent.whenIdle() },
    // wake=false 只入队不唤醒，一个 wake 抽干整个待办队列
    // （dev/contract/session-objects.test.js:146-180）；parts.js:774 只有第一条允许唤醒。
    send(message, list, wake) { return agent.send(message, list, wake) },
    // 排队到下一条 turn 并唤醒驱动，返回前消息已被认领；每条消息各自成 turn 且持久
    // user/message 保留调用方给的 id 与 source（:182-214）。
    followup(message) { return agent.followup(message) },
    // 切入正在运行的 turn 的下一步。**未锁定**：dev/contract 只锁了 send/followup/cancel，
    // 没有 steer 的锁测；真实表面 agent.d.ts:42（host.js §3 steer 注）。
    steer(input) { return agent.steer(input) },
    // 重投路径的另一半（parts.js:739 按 source.kind 分流）。**未锁定**（无锁测）；
    // 真实表面 agent.d.ts:43。
    inject(input) { return agent.inject(input) },
    // 取消待办；keepInbox 保留 inbox，否则清空
    // （dev/contract/session-objects.test.js:216-227）。
    cancel(reason, options) { return agent.cancel(reason, options) },
    // 在 Agent 的维护窗口跑一段作业（parts.js:869）。**未锁定**（无锁测）；
    // 真实表面 agent.d.ts:45。
    runMaintenance(job) { return agent.runMaintenance(job) },
    // 持久收件箱（src/host 29 处成员访问）：dev/contract/session-objects.test.js:69-134。
    get inbox() { return inboxView(agent.inbox) },
    // Agent 作用域上下文。契约 §3 的 AgentContext 只列 restrict/effect/plugin，而真实表面上
    // restrict 在工具服务上（dsh-tools lib/index.js:2991-3005 的 `restrict(filter)`，且
    // "requires a scoped context (agent.ctx)"），src/host 因此写 agent.ctx.tools.restrict
    // （agents.js:56/61、tools.js:715/721）；effect 与 plugin 是上下文自己的成员
    // （capabilities.js:310/423/426）。这里给的是与宿主同形状的读穿面，`tools` 一并透传，
    // 所以两种写法都落在真实对象上。
    // 已锁：deny 只影响本 Agent 的 schemas 与执行、未知全局名抛错
    // （dev/contract/session-objects.test.js:229-258）；贡献随 Agent 拆卸、拆后再注册抛
    // inactive-context（:260-272）；监听按 Agent 过滤（:274-292，仅锁测试驱动）。
    get ctx() { return contextView(agent.ctx) },
  }
}

// §3 AgentInbox：两个命名列表，读写都是日志里的持久 splice。
// append / clear / hasPending 只有锁测试驱动（dev/contract/session-objects.test.js:81-134），
// src/host 无调用点，按 host.js §3 末的标注不进本面。
export function inboxView(inbox) {
  return {
    // 下一步队列；计算键访问同样有效（:73-76，groups.js:415 依赖）。
    get nextStep() { return inbox.nextStep },
    // 下一轮队列。
    get nextTurn() { return inbox.nextTurn },
    // 插到本列表头部；持久 splice 且**不唤醒驱动**（:81-104、:136-144）。src/host 仅
    // parts.js:763 一处。
    prepend(list, message) { return inbox.prepend(list, message) },
    // 按 id 移除，返回是否曾在队列；活列表与持久 inbox 投影随后一致（:106-119）。
    remove(messageId) { return inbox.remove(messageId) },
  }
}

// ----------------------------------------------------------------------------
// §3 Session 对象面（host.js §3 SessionObject）
// ----------------------------------------------------------------------------

// Session 是 agent.session；src/host 实读 id、seq、eventAt、append、header、requestHeader()、
// deriveMessages。agentView(agent).session 给的是真实 Session 而不是这个面（理由见上），
// 所以本面由调用方显式使用；无论从哪条路拿到 Session，成员读都是读穿，本面交出去的值
// （append 的返回事件、deriveMessages 的消息）也一律是宿主自己的对象，可以直接传回宿主服务。
export function sessionView(session) {
  return {
    // 日志身份；与 agent.id、header.id 一致（dev/contract/session-objects.test.js:381-393）。
    get id() { return session.id },
    // 日志长度；seq-1 是最后一条已提交事件（:361-379）。chat-index.js:55 的 throughSeq
    // 与 :148 的 gap 校验基于此。
    get seq() { return session.seq },
    // 按序号取事件（:304/308/374）。btw.js:64 注明该成员对新调用者关闭，src/host 现存两处
    // （images.js:16、parts.js:1180，后者带 ?. 守卫）。
    eventAt(seq) { return session.eventAt(seq) },
    // 追加事件并返回已提交事件；seq 恰增一（:294-309）。契约校验两侧都抛：产消息事件必须声明
    // surfaceOp、纯日志事件不得声明、sourceEventSeqs 显式空数组拒绝（:311-324）；
    // image/offload 只在对应投影已注册时被接受，且拒绝时日志不变（:326-339）。
    // src/host 唯一调用点 images.js:202。
    append(type, data, options) { return session.append(type, data, options) },
    // 冻结记录：version、id、cwd、isSeeded、createdAt（:381-393）；写字段抛 read only
    // （:392）。实读 cwd（folders.js:49、parts.js:991/992/1075）。
    get header() { return session.header },
    // 无 header 事件时返回 undefined，之后折叠到最新一个且**返回缓存值**（:395-416）。
    // 实读 .config（parts.js:238/425/495/545/890、btw.js:143、browser/session-model.js:19）。
    requestHeader() { return session.requestHeader() },
    // 每次返回新数组、元素是共享的冻结消息（:418-439）；跟随 surface 替换而非原始日志
    // （:441-456）。src/host 6 处：btw.js:144、parts.js:228/428/501/562/910。
    deriveMessages() { return session.deriveMessages() },
  }
}

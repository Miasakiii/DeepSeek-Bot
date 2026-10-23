# C0 产物：DSH 依赖清单

- 日期：2026-10-23
- 相关：解耦主线阶段 C0（[设计](../plans/2026-10-22-decouple-from-dsh.md)）；本文是 C0 的第一项产物，动 C 之前由维护者评审
- 依据：2026-10-23 对 `ds-bot/src/host`（39 个文件）、`ds-bot/index.js`、`ds-bot/test/`、`ds-bot/dev/`、`app/src/` 的只读盘点；三路并行（服务/事件、工具/生态、测试/数据）加 Lead 复核
- 口径：数字均为 2026-10-23 实测。**与解耦设计原稿的差异**：`ctx.get` 服务 19 个 / 35 次（原记 17）；DSH 事件 14 个 / 31 次（11 个核心契约 + 3 个可选缓存失效）；工具实体 26 个（`ctx.tools` 30 是调用数）；浏览器桥不是 CDP（见 §六）；C0 估时由 ≤4-6 周上调（见 §十）

## 一、总览

| 类别 | 数量 | 说明 |
|---|---|---|
| `ctx.*` 调用 | 204 处 / 39 文件 | 12 个文件零 `ctx`（avatar、constants、files、handoffs、home-lock、links、steward、text、thinking 等） |
| `inject` 硬依赖 | 8 个服务 | `llm`、`tools`、`systemPrompt`、`sessionController`、`sessions`、`sessionTitle`、`workspaceRegistry`、`connection`（`index.js:41`） |
| `ctx.get` 可选服务 | 19 个 / 35 次 | 缺服务时大多有降级分支（见 §二） |
| DSH 事件 | 14 名 / 31 次注册 | 11 个核心契约（27 次）+ 3 个可选缓存失效（`ctx.on?.`，4 次） |
| `ctx.effect` | 26 处 | 全部依赖 cordis fiber 的 dispose 语义；7 处不清会坏（§四） |
| 工具实体 | 26 个 | `register` 25 次 + `attach/detach_capability` 循环注册 2 个 = 26；另有 30 处 `ctx.tools` 调用含 `schemas`/`restrict`/`guard` |
| 插件挂载 | 3 处 `ctx.plugin` + 2 个 `loader.import` 目标 | MCP client、GitHub 连接器、per-agent skill；`dsh-app-boot`（读版本用） |
| HTTP 路由 | 2 条 | `POST /api/bot`、`GET /api/bot/feed`（SSE），经 `ctx.connection.fetch.register` |
| 测试 DSH 耦合 | 40/93 文件（≈483/820 例）在 import 阶段即需要 DSH 包（含 2026-10-23 加入的 home-move.test.js） | `harness-resolve.mjs` 只是 specifier 重定向垫片，不是架构 seam（§七） |
| DSH 会话格式 | 当前写 v4；存在 v0→v1→v2→v3→v4 迁移链 | 迁移会改事件数与序号（§八） |

> 统计命令：`grep -o 'ctx\.[A-Za-z_]*'` 分类、`ctx.get?.('…')` 去重、`ctx.on?.('…')` 去重、`register(defineTool` 计数；全部可用本文 §附 的 call site 索引复核。

## 二、宿主服务依赖

### 2.1 `inject` 的 8 个服务（缺任一插件不加载）

| 服务 | 主要 call site | 用途 | C 方案 | E | 风险 |
|---|---|---|---|---|---|
| `llm` | `models.js:41/43`、`providers.js:196`、`images.js:95`、`parts.js:425/494/547`、`secrets.js:481`、`memory.js:1013`（19 次） | 模型目录、推理流、辅助调用（读图/记忆/摘要/脱敏重放） | A 已自有 wire 层；C 换自有 llm 服务（catalog/stream/adapter 注册） | E3 | 5 个 `llm/stream` 监听是流级中间件，互相重入保护；适配器注册表在 DSH 进程内 |
| `tools` | `tools.js:56…799`、`tools.js:686`、`agents.js:52/61`（30 次） | 工具注册与执行面 | C3 自有工具面；最小循环先自有两组工具，DSH 工具后置 | E3 | 审批/restrict/guard/超时/截断/spill/PTC；Bot 生产力强依赖 DSH 文件与 Shell 工具 |
| `systemPrompt` | `prompt.js:67`、`memory.js:798`（2 次） | 注入 Bot 身份与记忆段（order 640/645） | C1 自有 prompt 组装 | E2 | section 排序与前缀缓存 |
| `sessionController` | `channel.js:374`（turn 入口）、`roster.js:53`、`agents.js:94`、`models.js:135`、`usage.js`、`chat-index.js:58`、`parts.js:1250`（10 次） | 建会话、prompt、选模型、历史 page/投影、resolveAgent | C1/C2 核心：自有循环 + 自有会话 | E3 | DSH turn 生命周期、queue/abort/重入、Agent 对象面、事件词表；C 的本体 |
| `sessions` | `channel.js:333/358`、`groups.js:725/852`、`parts.js:732/991`、`images.js:199/203`、`delivery.js:101`（9 次） | `flush` 持久化、投影类型清单 | C2 自有事件日志（JSONL 等价） | E3 | 落盘时机、投影插件体系；chat-index/usage/feed 都依赖事件流 |
| `sessionTitle` | `agents.js:157`、`roster.js:55/239/308`（4 次） | 会话标题 | 并入自有会话元数据 | E1 | 无 |
| `workspaceRegistry` | `roster.js:21/27`、`folders.js:23/126/179`、`agents.js`、`parts.js`、`store.js:380/390`、`groups.js:197`（21 次） | 建/查工作区、归档会话 | C2 自有：工作区退化为会话 cwd 元数据 + 自有归档 | E2 | `archiveSession(…,{stopActivity})` 语义；与用户 DSH 项目列表的边界 |
| `connection` | `channel.js:423`、`feed.js:85`（2 次） | 注册 `api/bot` 路由与 SSE | B1 自有 node:http + token；C 暂留 | E2 | 浏览器 session cookie 认证；`dsh-web-app` 移除后服务消失，B1-3 必须把 inject 改可选 |

### 2.2 `ctx.get` 的 19 个可选服务（35 次；均已有缺失降级或可删）

| # | 服务 | 主要 call site | 用途 | C 方案 | E |
|---|---|---|---|---|---|
| 1 | `loader` | `capabilities.js:245`、`connectors.js:77`、`dsh-update.js:50` | cordis 动态 import（`dsh-mcp-client`、`dsh-app-boot`） | 保留 DSH / C3 生态单列 | E3 |
| 2 | `compaction` | `parts.js:251/256` | 猴补 DSH 压缩引擎（Bot 会话禁自动压缩、摘要改 DS Bot checkpoint） | **删**（自有循环无 DSH 引擎；parts 策略已自有） | E3→E1 |
| 3 | `agentPresets` | `roster.js:37`、`parts.js:251/255` | DSH 会话预设（standard/PTC） | 删或自实现 | E2 |
| 4 | `workingDirectory` | `folders.js:49`、`parts.js:1084` | 会话 cwd 读写 | 自有会话 cwd 元数据；缺失回落 `session.header.cwd` | E2 |
| 5 | `sessionProjections` | `channel.js:185`、`time-context.js:26` | 投影状态读取 | C2 自有投影，或先降级为缺失 | E2 |
| 6 | `attachments` | `delivery.js:130/144` | 长消息落文件、读回 | C2 自有文件存储 | E2 |
| 7 | `tokenMeter` | `parts.js:210` | 会话 token 计量 | 自有 usage/估算（`estimateTokens` 已兜底） | E2 |
| 8 | `approval` | `folders.js:147` | 工作目录越界审批 | C3 自有审批通道 | E2 |
| 9 | `sandboxPolicy` | `folders.js:142` | 判断是否需要审批 | C3 自有策略 | E2 |
| 10 | `permissionPresets` | `permissions.js:11` | 权限预设 catalog/resolve/set | C3 自有权限模型 | E2 |
| 11 | `settings` | `providers.js:55` | DSH 设置文档（provider 配置） | A1 自有目录；C 删 | E2 |
| 12 | `credentials` | `providers.js:56` | 凭据 describe/resolve | A2 自有密钥库；账号 OAuth 属独立前置 | E2→E3 |
| 13 | `agentDefaultModel` | `models.js:70/133` | profile 默认模型 | 自有模型设置 | E1 |
| 14 | `directoryPicker` | `folders.js:167` | 文件夹选择对话框 | B1 自有 UI 对话框 | E2 |
| 15 | `profileContext` | `browser.js:220`、`dsh-update.js:75`、`update.js:91` | 运行时形态/安装信息 | 自有运行时形态标志 | E1 |
| 16 | `pluginManager` | `update.js:87/116`、`dsh-update.js:81` | npm 源读取、安装更新 | 删（B2 自有更新链） | E1 |
| 17 | `schedule` | `schedules.js:80/81`（`ctx.inject` 动态） | 计划任务 | 自有调度器或先关闭 | E2 |
| 18 | `shellEnv` | `secrets.js:535/536`（动态注入） | 密钥注入 DSH Shell 工具 | C3 自有 Shell 时并入 | E2 |
| 19 | `goals` | `tools.js:707/708`（动态注入） | 阻断 Bot 会话里的 /goal | **删** | E1 |

> 独立入口 `ds-bot/web-search.js`（`inject:['web']` + 6 个 `ctx.get`）不属于 Bot 团队运行时，但属插件包；它依赖 DSH `web` 服务与账号 token，**C0 需单列「联网搜索去留」决策**。

## 三、事件依赖

### 3.1 11 个核心契约事件（27 次注册）

| 事件 | 类型 | 主要 call site | C 方案 | E |
|---|---|---|---|---|
| `llm/stream` | 瀑布流中间件 | `groups.js:877`、`images.js:179`、`secrets.js:473`、`usage.js:579`、`parts.js:1198` | C1 自有 stream 中间件链（可重放/合成） | E3 |
| `session/event` | 通知 | `turns.js:354`、`resume.js:131`、`feed.js:51`、`tools.js:721` | C2 自有事件总线（词表需覆盖 turn/user/assistant/tool/goal/image） | E3 |
| `agent/created` | 异步通知（创建等待监听完成） | `agents.js:70`、`capabilities.js:489`、`parts.js:298`、`tools.js:690` | C1 自有 agent 生命周期钩子 | E2 |
| `agent/status` | 通知 | `feed.js:47`、`images.js:193`、`parts.js:1188`、`memory.js:1470` | C1 | E2 |
| `agent/pre-step` | 瀑布流（`prepend`） | `parts.js:1016`、`time-context.js:18` | C1 自有 step 钩子 | E3 |
| `agent/request-error` | 瀑布流（`prepend`） | `parts.js:1114/1132` | C1 失败分类与切段重放 | E3 |
| `tools/execute` | 瀑布流 | `tools.js:336`（改写 working_directory）、`secrets.js:452`（结果脱敏） | C3 自有工具管线 | E2 |
| `approval/request` | 瀑布流（`prepend`） | `approvals.js:15` | C3 自有审批通道 | E2 |
| `system-prompt/assemble` | 瀑布流（`prepend`） | `parts.js:1082` | C1/C3 | E2 |
| `agent/assistant-stream` | 通知 | `feed.js:62` | C1 逐帧 SSE | E2 |
| `agent/inbox/discarded` | 通知 | `resume.js:121` | C1 | E2 |

### 3.2 3 个可选事件（`ctx.on?.`，4 次）

`llm/adapters-updated`（`models.js:17/182`）、`credentials/reference-updated`、`settings/document-updated`（`models.js:18`）：目录缓存失效 + 等晚注册 provider。C 方案 E1（自有事件或删除）。

### 3.3 会话事件词表（C2 数据契约）

DS Bot 实际读取 8 类 DSH 会话事件：`turn/start`、`turn/end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`image/offload`、`goal/change`；另 `tool/ptc-dispatch-start` 用于识别 PTC 模式。自有事件模型必须覆盖这 9 类（goal 可删）。

## 四、生命周期与隐藏依赖

1. **`ctx.effect`（26 处）**：`ctx.effect(execute,label)` 立即执行，disposer 在插件 fiber 卸载时按 **LIFO** 逆序执行，支持 async disposer。7 处不清会坏：`store.js:320`（文件锁等写入）、`capabilities.js:426/499`（per-agent 挂载与 MCP/skill fiber）、`parts.js:288`（压缩引擎反补丁）、`diagnostics.js:125`、`resume.js:241`、`usage.js:274`/`chat-index.js:127`（DB 句柄）。C0 的 fake-host 必须提供等价 lifecycle，否则相关用例无法迁移。
2. **`ctx.plugin` / loader（3 挂载 + 2 import）**：`capabilities.js:310` 在**每个 Agent 的 `agent.ctx`** 上挂 skill（内联 cordis 插件，`inject:['skills']`）或 MCP（`loader.import('@deepseek-ai/dsh-mcp-client')`）；`connectors.js:86` 挂 GitHub MCP；`fiber.await()/dispose()` 有就绪/超时语义。这是 cordis 深度 API，替代不是换壳。
3. **`ctx.connection`（2 路由）**：`POST /api/bot` 约 50 个 endpoint；`GET /api/bot/feed` 是 SSE（hello/revision/live/message/stream，20s keepalive，512 待发上限）。`handle()` 未导出，B1 需先抽 transport 层。
4. **Agent/Session 对象面（隐性契约，比多数服务更难）**：`agent.inbox`（26 处：nextStep/nextTurn/prepend）、`agent.session.*`（13）、`agent.ctx`（8）、`agent.followup`（6）、`session.deriveMessages()`（5）、`session.requestHeader()`（5）、`session.header`（4）、`session.seq`（4）、`session.append()`、`session.eventAt()`。`agent.id` 94 处（身份键）。
5. **中间件顺序语义**：6 处 `{prepend:true}`（approvals、parts×4、time-context）+ 全局「按注册顺序执行、usage 计量排最后」（`index.js:43-46`）。C0 契约需定义等价的 order 机制。
6. **cordis 隐藏运行时态**：`ctx.fiber?.uid === null` 与 `/in inactive context/` 文案判断（`parts.js:738`）依赖卸载期错误形态。
7. **DSH 纯函数 import（12 处）**：`defineTool`（`dsh-tools` ×5）、`createUserMessage`/`BlockAssembler`（`dsh-llm` ×7）、`WebError`（`dsh-web`）。数据层 E1，但需零语义薄替代（见 §七 风险 1）。
8. **客户端侧**（B1 范围）：inject 6（sessions/uiWorkspace/uiConversation/slots/theme/layout）+ `ctx.get` 5（locale/workspaces/sidebarRight/remote.speech/pluginNavigation）+ `ctx.sessions` 15 次 + `ctx.effect` 13 + `ctx.inject` 2。B1 由自有 UI 覆盖，本清单只登记。

## 五、工具面与执行语义

### 5.1 工具实体（26 个；全部 Bot 语义，注册在 DSH 工具表）

| 归类 | 工具 |
|---|---|
| Bot 协作（tools.js 15 + 循环 2） | `list_bots`、`message_bot`、`stop_bot`、`create_bot`、`update_bot`、`list_models`、`create_group`、`update_group`、`delete_group`、`post_to_group`、`ask_user`、`show_view`、`list_capabilities`、`save_capability`、`delete_capability`、`attach_capability`、`detach_capability` |
| 群聊（groups.js 3） | `group_relay`、`read_own_chat`、`read_group_chat` |
| 记忆（memory.js 3） | `remember`、`forget`、`recall` |
| 密钥（secrets.js 2） | `request_secret`、`list_secrets` |
| 浏览器（browser.js 1） | `read_browser` |

> Bot 真正干活的文件 / Shell / 搜索 / 浏览器工具**不在这 26 个里**，而是 DSH standard preset 提供的 `dsh-tool-fs`/`fs-search`/`pwsh`/`bash`/`jobs`/`web`/`present` 等；C3 要另建这一层（见 §5.3）。

### 5.2 执行语义（自有循环必须复制）

| 语义 | DSH 提供者 | DS Bot 现状 | 自有循环必须实现 |
|---|---|---|---|
| 审批流 | `dsh-user-approval`：`approval.request`、`approval/request` waterfall、一次性、活动轮次内、abort→cancelled、fail-closed、审计事件 | `approvals.js:15`（群 Session 转群卡、私聊让位 DSH 卡）、`channel.js:271`、`folders.js:140-163`、`resume.js:21/165` | 请求/结果/审计/轮次约束/fail-closed + 群与私聊两条作答通道 + 越界目录审批 + 重启回收 |
| `restrict` | per-agent deny/allow 掩码、dispose 解除、未 serve 名称抛错 | `agents.js:45-68`、`tools.js:669-698` | per-agent 可见集、创建即生效、安全失败、dispose 解除、schema 顺序稳定（前缀缓存） |
| `guard` | pre-execute 后的单调同步守卫 | `tools.js:686` | 单调、不可逆、理由进模型内容 |
| 超时 | `dsh-tool-call-timeout-policy`（声明式 `timeoutMs`） | 26 工具均未声明；业务超时：browser 15s、capability 15s、群轮 240s、OCR 120s、PTC 600s | 协作式取消（`exec.signal` 贯穿）、per-tool 截止、结构化超时、取消后 quiescence、硬停兜底 |
| 结果截断 | `dsh-output-retention` + tool-result pruner | `TEXT_KEPT`、`MESSAGE_INLINE_MAX` 等业务常量；`state.json` 只留头部 | 结果预算 + head/tail + 省略告知 + 恢复指引 + 旧结果剪枝 |
| spill | `dsh-spill-local`/`spill-policy`（`maxInlineTokens`） | **零代码，全吃 DSH** | spill 后端 + 恢复提示 + 清理策略；放弃则长结果不可恢复 |
| 输出保留 | 同上 | 长消息落 DSH 附件（`delivery.js:127`） | 自有附件存储 + 截断常量表迁移 |
| 并行/串行 | `isConcurrencySafe` → parallel/exclusive 屏障；PTC `maxParallelSubCalls` | 26 工具 0 声明（全 exclusive）；群轮显式串行；`group_relay` 阻塞整轮 | 并发分类、exclusive 屏障、`run_code` 或等价 transport、`tool/ptc-dispatch*` 等价事件、`exec.concludeTurn`、`steer/followup` 两级队列 |

> 工具流水线契约（`dsh-tools` 0.2.1-rc.2）：`tools/pre-execute` → 单调 guard → `tools/execute`（可换 signal）→ `tools/post-execute` → `finalizeContent` → 只读 `tools/result`。未知工具/异常返回结构化错误但**不结束轮次**。C 循环需要整条流水线 + tool result 投影。

### 5.3 工具面最小可用集 vs 完整集

- **最小集（C3 必须）**：Bot 协作 12 个（含 `group_relay` 与长消息）+ 文件 4（read/write/edit + glob/grep，带 sandbox 边界与审批）+ Shell 2（pwsh、bash）+ **后台 jobs**（长命令/服务，最容易漏）+ `working_directory` 语义 + `read_browser` + 记忆 3 + 密钥 2 + `ask_user`。
- **完整集（再加）**：MCP（`mcp__*` 工具与资源）、skill 目录与加载、连接器、图片/OCR、语音、附件全套、`web_fetch`/`web_search`、todo、schedule、present、subagent/workflow、plan mode、usage/统计/压缩、tool result 剪枝。
- **可删/延后**：goal 工具、`ask_user_question`（已 guard 拒绝）、plan mode/exit_plan_mode、ralph、todo（Bot 场景弱）、`list_mcp_resources`（随 MCP 走）。

## 六、生态依赖

### 6.1 MCP / skill / 连接器

- **capabilities.js**：库存在 `state.capabilities.items`；按 Agent 挂载到 `agent.ctx`。MCP 走 `loader.import('@deepseek-ai/dsh-mcp-client')` + `ctx.plugin(plugin, {transport, serverName, command/url, headers, args, env, failOnStartupError:true})`；skill 是内联 cordis 插件（`inject:['skills']`）；stdio MCP 需用户在设置里批准；`$DSH_SECRET_X` 启动时换真值只在内存；每 Agent 一条串行 reconcile 链、config hash 重挂、`fiber.await()/dispose()`、15s 软超时。
- **connectors.js**：GitHub = 预置 streamable-http MCP，复用同一条 loader + `ctx.plugin`；token 只进 MCP headers。
- **C 建议（三档用户口径）**：
  1. **MCP：保留**——用中立的 `@modelcontextprotocol/client`（`dsh-mcp-client` 的底层依赖，MIT）自写薄桥（`mcp__server__tool` 命名、schema 转换、60s 超时、重连退避、stdio 审批、spill 兼容）；成本低、协议开放。
  2. **skill：自有实现**——降级为「本地目录/内置提示词 + 按需加载」，不保留 `ctx.skills` 注册表语义。
  3. **终止**：DSH 引擎插件（cordis 插件）与 DSH 界面插件（B1 后已不可用）；PTC 呈现模式放弃，但为旧群 Session 做兼容 shim。
- README / CHANGELOG 应提前写成三档口径，避免承诺断裂。

### 6.2 浏览器桥（**不是 CDP**）

`read_browser`（`browser.js:229`）→ host 长轮询（`browser-wait` 20s、2s 重发、15s 读超时）→ **DSH Desktop 壳** 的 `window.dshDesktop.browser.acquire('bot:<id>')` 租独立 partition 的 Electron webview → `executeJavaScript(READ_PAGE_SCRIPT)` 读 Markdown → `browser-result` 回传。依赖是 Electron 壳，不是 DSH engine，也不是 CDP。**自有 `app/` 只暴露 `dsBotApp`、未开 webview → B1 启用自有 UI 后 `read_browser` 会静默不可用**（只剩 `NO_BROWSER` 提示）。B1 必须自建壳桥（preload + webview/WebContentsView + IPC + 每 Bot partition），这是原先漏估的数周工作量。

## 七、测试 seam

- **测试入口**：`node --import ./test/harness-resolve.mjs --test "test/*.test.js"`；93 个测试文件、820 个静态 `test()` 声明，runner 836 例（多出 16 为循环生成；2026-10-23 改名收尾加入 home-move.test.js +4 例，2026-10-24 复核）；`npm test` 实测 836 / 835 过 / 1 跳过 / 6.0-6.3s。
- **`harness-resolve.mjs` 是语言级垫片**：把插件目录下 `@deepseek-ai/*` specifier 重定向到 `DSH_HARNESS` / `dev/harness` / 上级 checkout；版本钉 `dsh@0.2.1-rc.2`。**不是架构 seam**。
- **40/93 文件（≈483/820 例）在 import 阶段就需要 DSH 包**（`index.js` 与 `src/host` 顶层 import `dsh-llm`/`dsh-tools`；home-move.test.js 经 `../index.js` 依赖闭包计入，2026-10-24 复核）；另有 3 个客户端测试经 `DSH_HARNESS` 取 jsdom。删掉 `dev/harness` 安装，43 个文件连加载都过不去。
- **`fake-ctx.js` 只覆盖注册面**：logger/get/on/emit/effect/dispose、tools.register/guard/schemas、systemPrompt.section、connection.fetch.register、llm.listProviders + `fakeAttachments`；**不提供** sessionController/sessions/sessionTitle/workspaceRegistry 语义。契约测试的内联 fake 有 20+ 服务、30 个文件各写一套。

| 层 | 判定 | 文件/例 | C 策略 |
|---|---|---|---|
| L1 纯逻辑·无 DSH | import 期不需要 DSH 包 | **53 / ≈337** | 直接迁移；3 个 jsdom 测试改由 ds-bot devDeps 提供 |
| L2 契约·fakeContext + 内联服务 fake | 注册面 + 20 服务 fake | **29 / ≈388** | 抽 `fake-host`，按服务面逐批替换（不重写） |
| L3 语义耦合·包或词汇 | import 需 DSH 包或断言 DSH 词表 | **10 / ≈91** | 零语义薄替代 + 事件词表 compat fixture |
| L4 端到端/双跑 | 真 DSH host + mock 模型 | smoke（44 步）、bench、check、ui-shots、memory-e2e、steward-eval、shared-home-check | 升级为双跑 golden master（见 §九） |

## 八、数据与会话格式

### 8.1 数据归属

| 数据 | 归属 | DSH 依赖 | C 影响 |
|---|---|---|---|
| `state.json`（version=1、bots/rooms/prefs/exchanges/questions/views/capabilities/secretRequests/revision…） | 自有 | 无 | 直接迁移；**只有 version:1，无版本链**，迁移逻辑在 `store.js adopt()`（十余条临时规则） |
| `workspaceId` | 自有字段，值是 **DSH workspace 记录 id** | `workspaceRegistry` | C 需自有 workspace 概念或改存真实路径 |
| `bot.sessionId` / `segments[].sessionId` / `room.sessions{botId}` / `questions{sessionId}` 等 | 自有字段，**键 = DSH Session id** | `sessionController.create` | 冻结「id 即键、id 永不变」不变式（Bot id 本是首会话 id），迁移需 id 映射表 |
| `bot.workDir` / `room.workDir` | 自有，绝对路径 | DSH cwd 语义（会话建立即固定，改变走新 part） | 自有循环必须保留「每会话固定 cwd + 变更即新 part」 |
| `memory/`（team/bots/groups + journal + snapshots/<sessionId> + summaries） | 自有 | 键用 sessionId | 键可沿用；快照失效靠 renewMemory 重建 |
| `chat-index.sqlite`（FTS5，`through` = **DSH 事件 seq**） | 自有格式，派生自 DSH 日志 | `sessionController.page` 的 seq | seq 语义变则静默错配；可整表重建 |
| `usage.sqlite`（`through` = DSH seq） | 同上 | 同上 | 同上 |
| `inflight.json`（含 approval 语义） | 自有 | approval 语义来自 DSH | 保留；崩溃恢复指标要自建 |
| `secrets.json`、`ocr.json`、`logs/`、`group-lines/` | 纯自有 | 无 | 直接迁移 |
| `state.lock`（home-lock.js 自研） | 自有 | 无 | 保留（多窗口/多 host 仍需要） |
| DSH 侧 `sessions/`、`attachments/`、`profiles/`、`.credentials.yaml` | DSH 所有 | – | 只作导入/迁移源（`app/src/import.mjs` 已实现拷贝） |

### 8.2 DSH 会话格式（0.2.1-rc.2）

- 当前写 **v4**（`dsh-session-format-catalog`：`currentVersion: 4`，codecs v0–v4，四条迁移边，gap-free 校验）。
- 物理布局：每会话一个目录，`session[.vN].jsonl[.zstd]`；默认 zstd 且每帧带 checksum；v0/v1 有 packed assistant-delta 行；一 root 只能一种编码。
- 迁移语义：v1→v2 嵌入 assistant 流并**改事件数/序号**；v2→v3 插 system 头并**再改序号**；v3→v4 `tool/result` 改角色 + parent catalog 校验；迁移不可逆、无 fallback、无删除 API；write-open 会发布 v4 successor 而源文件不动。
- **风险**：① 序号漂移 → `#seq` 锚点（chat-index/usage/memory/handoff）历史迁移后错位，需重算/回填工具；② parent-child catalog → 只拷父会话会迁移告警；③ 版本天花板 → 上游发 v5 后 app import 直接拒收，升级链断；④ 自有工具链要么复用 DSH 后端、要么自实现 zstd 帧恢复（Node 24 内置 zstd 可用）；⑤ 回滚只能靠导出快照。

## 九、双跑 golden master 资产

| 资产 | 现有能力 | 缺口 |
|---|---|---|
| `dev/mock-llm.mjs`（55.8KB） | Anthropic Messages SSE + `GET /v1/models` + Ollama 形状 web_search；剧本覆盖建群/群发/派活/记忆/视图/能力/长文/错误注入/摘要三类/steward 判定；日志含 system/tools 哈希、session、token 估算 | 只有 Anthropic 线序（A5 补 OpenAI）；故障注入仅 401/400/overflow；无图片成功路径、断流/超时/429、zstd/附件 |
| `dev/smoke.mjs --out` | 44 步 API 级 E2E + 归一化转录 JSON（state 摘要、Bot/群按名排序、文本截断、去时间） | **无 golden 基线、无 diff 工具、无差异报告**；归一化粒度粗（无 prompt/tools 全量、摘要全文、usage）；缺审批/压缩切换/崩溃恢复/图片/语音/浏览器场景 |
| `dev/llm-tap.mjs` | OpenAI/Anthropic 透传日志 + prefix firstDiff（缓存前缀对比）+ 全量请求体 | 需真实 key；不参与 bench/smoke；无差异报告 |
| `dev/bench.sh` | mock + 真 `dsh web`，profile 软链，`reset/stop/status`，数据在 `.dsh-test-<name>` | 依赖 `deepseek-harness` checkout + POSIX `sh`/`setsid`；**本机 Windows 不可执行**；硬编码 checkout 内 overlay；无 Windows 入口 |
| CI | 只跑 `npm test`/build/lint | **不跑 smoke/bench**，无双跑防线 |

**C0 必须补**：① golden 基线资产；② `dev/golden-diff.mjs`（归一化 + step diff + mask 规则 + 差异报告）；③ 双跑入口（DSH 循环 vs 自有循环，或先做「自有 turn 驱动 + DSH 事件写回」tracer bullet）；④ Windows 可执行入口（WSL 或补 checkout，待定）；⑤ 归一化补全（system prompt/tools hash、摘要全文、usage、审批决策、错误分类）；⑥ mock 补 OpenAI 线序；⑦ 场景补审批/压缩切换/崩溃恢复/usage/多端并发。

## 十、C0 工作项与估时（单人）

| # | 工作项 | 估时 | 备注 |
|---|---|---|---|
| 1 | 92 文件 × 816 例迁移台账 + CI「禁止新增 `@deepseek-ai` import」守卫 | 1–2 天 | – |
| 2 | jsdom 来源从 `dev/harness` 改为 ds-bot devDeps | 0.5 天 | – |
| 3 | 抽 `fake-host`（注册面 + 20 服务默认实现），30 个契约文件改用它（≈390 例） | 5–7 天 | 依赖 rt.host 接口 |
| 4 | 6 个手搓 rt 文件（68 例）改用统一 `installHost` helper | 2 天 | #3 |
| 5 | **零语义薄替代**：`createUserMessage` / `BlockAssembler` / `defineTool` / `WebError` 最小实现 | 2–3 天 | **必须与 #3 并行或更早**，否则 39 文件 import 卡死 |
| 6 | 事件词汇兼容层：8 类会话事件 + 11 个 DSH 事件 → 自有模型（5 文件/41 例） | 3–4 天 | #5 |
| 7 | 双跑入口 Windows 化（mock + dsh web 或 WSL 方案） | 3–5 天 | – |
| 8 | golden 基线 + `dev/golden-diff.mjs`（归一化、step diff、差异报告） | 3–4 天 | #7 |
| 9 | 数据面：state.json 版本链骨架 + 导出/导入 round-trip | 4–5 天 | 可推 C2 前置 |
| 10 | DSH JSONL fixture（v0–v4 各一份 + zstd/none + v5 拒绝路径） | 2–3 天 | 可推 C2 前置 |
| 11 | 双跑场景扩展：审批、压缩切换/回退、崩溃恢复、usage、错误分类 | 4–6 天 | – |
| | **合计** | **≈30–41 人日** | 另需 `rt.host` 契约层（服务/事件/对象面/顺序/lifecycle）与依赖清单评审 |

**结论（2026-10-23 已拍板）**：C0 原估「≤4-6 周」不成立。走**关键路径 6-8 周**口径：保 #3/#5/#6/#7/#8（≈18-23 天）+ rt.host + 依赖清单；#9/#10 降级为 C2 前置；#11 只做审批 + 压缩两项。全量 8-10 周作为备选，不作为当前计划。

## 十一、最小 tracer bullet 边界

**推荐先做的最小循环**：只替换 turn 驱动（`sessionController.prompt` → 自有 loop），事件通过 `agent.session.append` + `sessions.flush` 写回 DSH 会话，保留所有读面（page/projections/usage/feed/chat-index/search），从而具备双跑 diff 能力。

**必须先替代（最小循环核心）**：`llm.stream` + 目录；`sessionController.prompt/create/selectModel/resolveAgent`；Agent 对象面最小集（append/seq/inbox/followup/status/requestHeader）；事件发射（session/event、agent/status、agent/created、agent/pre-step、llm/stream 至少各 1 个自有钩子）；systemPrompt 组装；sessionTitle。

**可先打桩保留/降级（15 项）**：loader/ctx.plugin 生态（MCP/skill/GitHub 可先关闭）、pluginManager/profileContext（关更新）、schedule/shellEnv/goals（不注入即缺席）、compaction/agentPresets（删 wrapper）、browser（可强制关）、directoryPicker（手填路径）、attachments（长消息退回内联）、tokenMeter（estimateTokens 兜底）、sessionProjections（缺失降级）、sandboxPolicy/approval/permissionPresets（跳过审批需 UI 提示）、agentDefaultModel（取第一个 served model）、workingDirectory（回落 header.cwd）、workspaceRegistry（先用 cwd 建会话）、connection（B1 换）、settings/credentials（A 阶段已排期）。

## 十二、风险与待确认

**最大风险**

1. **测试 seam 是语言级的，不是架构级的**：59% 用例 import 阶段就依赖 DSH 包；若只抽 fake-host 而不先做零语义薄替代，C 一开始就被 import 卡死。→ #5 提前/并行。
2. **数据键控的隐性契约**：`sessionId` 即键、`through` 是 DSH 事件 seq、`workspaceId` 是 DSH 记录 id；自有循环若重生成 id 或改 seq 语义，派生数据静默错配；DSH 迁移边会改事件数/序号。→ 冻结「id 不变 + seq 单调度量」不变式并交付重算/回填工具。
3. **双跑验收本机不可执行且无 golden 资产**：bench/smoke 依赖 POSIX + checkout，CI 不跑 smoke；`--out` 只有归一化 JSON，无 diff 工具/基线/差异报告。→ C0 内先落 Windows/CI 入口 + 基线 + 差异报告。
4. **浏览器桥被误记为 CDP**：实际是 Electron 壳 webview 租约；B1 后 `read_browser` 静默消失，需自建壳桥（数周）。
5. **生态决策悬空会同时卡 B1 与 C**：MCP/skill/连接器去留决定 vision 承诺与 README 口径。

**待确认**

- DSH workspace 注册表的具体存储路径（`dsh-storage-json` 域实现未读）。
- v0/v1 packed 行的字节级格式（只读 README，未读 codec 源码）。
- 双跑在本机走 WSL 还是补 `deepseek-harness` checkout。
- app `move-data.mjs` 的旧 home 布局与新 home 规则是否在 B2 前定稿。
- `web-search.js`（联网搜索）去留；PTC 兼容 shim 的范围。

## 附：完整 call site 索引

- 服务：见 §二 表的 call site 列；`grep -n "ctx\.get" ds-bot/src/host/*.js`（32 处显式 + 3 处 `ctx.inject` 动态）。
- 事件：`grep -n "ctx\.on" ds-bot/src/host/*.js`（31 处，§三 表已列全）。
- 工具：`grep -n "name: '" ds-bot/src/host/tools.js`（15 + 2 循环）、`groups.js`（3）、`memory.js`（3）、`secrets.js`（2）、`browser.js`（1）。
- effect：`grep -n "ctx\.effect" ds-bot/src/host/*.js`（26 处）。
- 插件挂载：`capabilities.js:310`、`connectors.js:86`、`dsh-update.js:51`。
- 路由：`channel.js:423`、`feed.js:85`。
- 数据布局：`store.js`、`home-lock.js`、`folders.js`、`chat-index.js`、`usage.js`。
- 测试分层：`test/harness-resolve.mjs`、`test/fake-ctx.js`、各 `*.test.js`。

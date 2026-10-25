# 与 DSH 解耦：自有 LLM 层、宿主、Agent 循环与移动端

- 日期：2026-10-22 建立；2026-10-23 评审后修订（见文末「变更」）
- 相关：[ROADMAP.md](../../ROADMAP.md)（fork 规划入口）；C0 依赖清单（[`docs/dev/c0-dsh-dependency-inventory.md`](../dev/c0-dsh-dependency-inventory.md)，2026-10-23 完成）；本文是「解耦主线」的总设计，各阶段动工前以本文为准
- 背景数据：2026-10-22 对全仓 DSH 耦合点的实测（见「为什么」）；2026-10-23 复核：`src/host` 共 204 处 `ctx.*`（39 个文件）、14 个 DSH 事件（11 核心 + 3 可选）、19 个 `ctx.get` 服务；`registerAdapter` 的公开性经类型定义、包 README 与官方适配器自用三方确认
- 已拍板（2026-10-23，见 §「已定决策」）：阶段顺序 A→B1→C0→C→B2→D；B1 保留 Host 子进程；账号 B1 沿用 DSH 账号服务、C 自研 OAuth；发布身份改 fork 自有 appId 与更新源；插件生态 MCP 保留 / skill 自有 / 引擎与界面插件终止；C0 走关键路径 6-8 周

## 为什么

三个目标：

1. **与 DSH 解耦**：不再依赖 DeepSeek Harness 作为运行时，最终形态是独立软件。
2. **不需要 agent 模式**：DS Bot 的团队界面就是唯一界面，不再背负 DSH 经典 Agent 模式。
3. **多厂商与自定义模型 + 移动端**：模型不止 DeepSeek，可接其他厂商和自托管端点；手机平板可用。

实测结论（决定路线的依据）：

- **客户端具备独立的代码基础，但尚未启用**。现装桌面 app 的窗口仍是 DSH 网页前端（`app/src/profile.mjs` 的 bundles 含 `dsh-web-app`，`app/src/main.mjs` 加载 Host 的 URL）；`app/ui` 的自有窗口是 2026-10-17 做、10-18 搁置的 On hold 原型（`app/README.md` §Layout 明写「On hold, not installed / not built or packaged」；`vite build` 能过，但没有接进安装包）。它的通信面确实只走 `api/bot`（POST + SSE feed，`app/ui/src/api.js`），唯一外部依赖 `@deepseek-ai/dsh-client-ui-primitives` 已被自研 React 组件替换（`app/ui/src/primitives.js`，由 `app/vite.config.js` 的 alias 注入），Bot 视图复用插件 client（65 个文件）。**B1 启用它是一项独立工作项（功能对齐、打包、登录入口），不是零成本切换。**
- **服务端业务逻辑全部自有**：state.json、群聊、派活树、记忆、分段、Bot 工具。
- **仍绑在 DSH 的是四块基底**（按 `src/host` 的 `ctx.*` 调用计数；2026-10-23 复核一致）：
  1. Agent 循环：`sessionController`×10、`sessions`×9、`sessionTitle`×4——每个 Bot 是一个 DSH Session，turn 由 DSH 执行；turn 入口即 `channel.js` 的 `ctx.sessionController.prompt`；
  2. LLM 适配：`ctx.llm`×19（`stream` / `resolveModelInfo` / `listProviders` / `listModels` / `listConfigurableProviders` / `discoverModels`）；
  3. 工具执行：`ctx.tools`×30——Bot 干活用的文件 / Shell / 浏览器工具是 DSH 的；
  4. 宿主与生态：`ctx.plugin`（cordis 加载 MCP / skill / 连接器）、`ctx.connection.fetch`（注册 `api/bot` 路由）、`workspaceRegistry`×21、凭证库。
- **关键使能点（2026-10-23 已核实）**：DSH 的 llm 服务是「适配器注册表 + 瀑布流拦截的流式 API」，`ctx.llm.registerAdapter(providers, adapter)` 是公开文档化扩展点——`@deepseek-ai/dsh-llm` 的类型定义 `registerAdapter` 签名带 JSDoc 原文「Register implementations with `ctx.llm.registerAdapter(providers, adapter)`」，包 README 称其为接入适配器的唯一受支持路径，官方 DeepSeek / pi-ai 适配器自己也经它注册。`LlmAdapter` 抽象类提供 `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream` 等。因此**阶段 A 可以完全走公开 API 实现自有 LLM 层，不需要打任何补丁**；但注册表本身在 DSH 进程内，A 的解耦只到 wire 层，真正的去运行时在 C/B2。

因此路线原定为四阶段，原顺序 **A → B → C → D**（2026-10-22 用户拍板）。2026-10-23 评审发现原 B 同时承担了「去 DSH 网页前端」与「去 DSH 运行时」两件事，而后者要等 C 换掉循环才成立；修订为 **A → B1 → C0 → C → B2 → D**：B1 去前端（DSH Host 保留），C0 为 C 的可执行性前置，C 换循环，B2 去 DSH 宿主，D 移动端。**2026-10-23 已拍板采用此顺序**（见「已定决策」）。

## 已定的行为

### 阶段 A：自有 LLM 层（约 2-4 周）

目标：provider 目录、密钥、协议客户端全部自有；DSH 的循环继续跑 turn，但模型的「服务方」变成 DS Bot 自己的适配器。

**A1 自有 provider 目录**

- 新增 `src/host/llm.js`，provider 登记进 DS Bot 自己的 `state.json`（不再写 DSH 的 settings document）：
  `{ id, name, protocol, baseURL, models: [{ id, name?, contextWindow?, maxTokens?, input? }], keyRef }`
- `models.js` 的 catalog 改为从自有目录构建；`providers.js` 的增删改、`discoverModels`（GET `{baseURL}/models`）改为自有实现，不再经 `ctx.llm.discoverModels`。
- 首次启动迁移：读取 DSH 现存 provider（`ctx.llm.listConfigurableProviders` 与设置文档）拷入自有目录，老用户无感。DSH 的 DeepSeek 账号路由（OAuth）**不重写**，继续由 DSH 自己的适配器服务；catalog 合并「自有 provider + DSH 剩余路由」。
- 迁移的防撞与边界（2026-10-23 补）：拷贝后必须清掉 DSH settings 里的同名 provider，或给自有 id 加命名空间——同一路由被 DSH 与自有适配器各注册一次会抛 `DUPLICATE_ADAPTER`。账号路由的 token 与 env 来源 key（`DEEPSEEK_API_KEY`）的迁移语义单列；账号记录暂留 DSH credentials（B1 之前处理，见「独立化前置」）。
- A 的客户端接线（2026-10-23 补）：插件形态下 Models 页被隐藏（该页只在带 `actions.providers` 的窗口出现），A 若不补「Models 页在插件/web 形态可见、provider 动作接自有端点」，自有目录没有 UI 入口，用户仍要去改 DSH 设置——「多厂商」收益兑现不了。

**A2 自有密钥库**

- 密钥落 `home/keys.json`，`node:crypto` AES-256-GCM 加密，密钥文件权限 0600；`keyRefFor()` 的展示约定保留（`providers.js` 现状）。
- 写密钥不再触发 DSH 的 `settings/document-updated`；DS Bot 与 DSH 设置在密钥上彻底分家。

**A3 自有适配器（阶段 A 的核心）**

- 实现 `class BotLlmAdapter extends LlmAdapter`（从 `@deepseek-ai/dsh-llm` 导入抽象类，属文档化插件 API），安装时 `ctx.llm.registerAdapter(ownProviderIds, adapter)`。
- 适配器实现三个协议客户端，均映射到 DSH 的 StreamChunk 词表（实际事件为 `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`，2026-10-23 修正），并遵守适配器契约：每个 provider HTTP 请求带 `attributionHeaders()`；`listModels` 供目录；`resolveModel` 返回 contextWindow / reasoning efforts / modalities；动态 provider 覆盖 `prepareCall`，把「模型元数据 + 请求分发」绑到同一代（settings 变更不串代）。
  1. `openai-completions`：POST `{baseURL}/chat/completions`，SSE；
  2. `openai-responses`：POST `{baseURL}/responses`，SSE 事件流；
  3. `anthropic-messages`：POST `{baseURL}/v1/messages`，SSE，`x-api-key`。
- 自托管端点（Ollama / vLLM / LM Studio / one-api 等）一律走 `openai-completions` + 自定义 baseURL，即「自定义模型」的落地形态。
- 新增协议（如 Gemini）只在 `llm.js` 加一个客户端，不依赖 DSH 是否支持。

**A4 调用方零改动**

- DS Bot 的辅助调用（`images.js` 视觉读图、`memory.js` 记忆整理、`parts.js` 上下文压缩摘要、`secrets.js`）继续调 `ctx.llm.stream({ provider, model, … })`：自有 provider 的路由经注册表落到自有适配器，**这些文件不改代码**。前提：自有 provider ref 与 DSH catalog/GUI 规则一致（GUI 选模型必须在 catalog 里），且 `models.js` / `providers.js`（A1 明确要改）不属于「不改文件」范围。
- `usage.js` 的 `llm/stream` 瀑布流计量继续生效（适配器照常产出 usage chunk）。
- turn 的模型应用仍走 `ctx.sessionController.selectModel`（DSH 循环的选型入口），`agentDefaultModel` 仍是 DSH 的 profile 默认——阶段 A 不动循环。

**A5 测试**

- 不新建 mock 服务器，扩展现有 `dev/mock-llm.mjs`（55KB，已按 Anthropic 线序驱动全团队流程）与 `dev/llm-tap.mjs`（OpenAI/Anthropic 透传日志），补 OpenAI Responses 与 SSE 事件流；测试零 token、无外网。
- 适配器单测覆盖：三协议 SSE 解析、错误分类（AUTH / RATE_LIMIT / 超时）、`prepareCall` 代际绑定、密钥缺失与拒绝路径、`DUPLICATE_ADAPTER` 防撞。

**阶段 A 的验收（2026-10-23 量化）**：

- 三协议 mock 各覆盖正常流、usage、工具调用、max-tokens 截断、AUTH / RATE_LIMIT / 超时、密钥缺失，单测全绿；
- 端到端（mock + 一个真实自托管端点）：新建 provider → 在界面选中它的模型 → Bot 完成一轮 → 读图 / 记忆整理走通，全程不写 DSH 设置；
- 迁移 fixture：老用户 DSH provider 拷贝后不抛 `DUPLICATE_ADAPTER`，账号路由仍可用；
- `npm test`（836 例基线，2026-10-24 复测 836 / 835 过 / 1 跳过，约 6s；含 home-move.test.js 4 例）+ `build --check` + lint 全绿；DSH 账号登录路径回归通过。

### 阶段 B1：自有前端与自有出口（约 4-8 周）

目标：**去 DSH 网页前端**——窗口换成自有 UI，`api/bot` 有一个不依赖 DSH `connection` 服务的出口；turn 仍由 DSH 执行（C 才换循环）。

- **B1-0 运行时形态（2026-10-23 已拍板：选项 2）**：B1 的 DSH 运行时载体保留**独立 Host 子进程**（现结构，只把入口换成自有 server）。备选未采用：① 自有入口内嵌 DSH 库（Electron 主进程拿不到 `--expose-internals`，HMR 与崩溃隔离受限）；③ 自有 server 跑在现有 DSH Host 内、只去 `dsh-web-app`（出口仍依附 DSH 生命周期）。**「app 里没有 DSH 进程」不是 B1 的验收判据**——DSH 运行时仍在，只是不再以 DSH 产品形态出现。
- **B1-1 自有 HTTP 出口**：`channel.js` 的 `handle(endpoint, payload, signal)` 目前未导出，且实现依赖 DSH 会话服务（`ctx.sessionController.prompt` 等）；先在 `channel.js` / `feed.js` 抽出可注入的 transport 层，再起 `node:http`：`POST /api/bot`、`GET /api/bot/feed`（SSE）、客户端静态文件。认证用自有 token（本地回环；局域网绑定留到 D 的可行性验证）。
- **B1-2 启用自有 UI**：把 `app/ui`（On hold 原型）接回安装包：功能对齐清单（群聊、Bot 详情、设置、搜索、审批、widget 视图、记忆、用量、登录入口）、**浏览器壳桥**（`read_browser` 依赖 DSH Desktop 壳的 Electron webview 租约，自有 `app/` 目前只暴露 `dsBotApp`、未开 webview，需自建 preload + webview/WebContentsView + IPC + 每 Bot partition，否则 `read_browser` 在自有 UI 里静默不可用）、`vite build` 接入 `electron-builder.yml`、截图对比验收。这是 B1 的主要工作量。
- **B1-3 profile 调整**：app profile 的 bundles 去掉 `dsh-web-app`，保留 `dsh-base` + `miasaki-dsbot`；`connection` 服务由 `dsh-web-app` 提供，ds-bot 的 `inject` 需改为可选或由自有装配提供；`webServer` 同样由 B1-1 的自有 HTTP 出口取代。
- **B1-4 配置迁移（原 B4）**：插件 `config.*` 旋钮共 **29 处读取 / 19 个键**（2026-10-23 复核；原记「13 处」不准确，完整清单见 ROADMAP §四「并行轨道 · 配置层盘点」），迁移到自有配置文件；插件形态（web 端）与 app 形态的双配置源如何合并，单列设计。
- **B1 验收（量化）**：窗口 origin 是自有 server；profile 无 `dsh-web-app`；一个 Bot 在自有 UI 里完成「发消息 → turn 跑完 → 流式渲染」；群聊 / 详情 / 设置 / 搜索 / 审批各一张截图通过对比；插件形态（DSH web）不受影响；`npm test` + lint 绿。
- **B1 回滚**：保留 profile 切回 `dsh-web-app` 的开关（启动参数或配置），一个版本内可回退到 DSH 网页前端；自有 UI 以 beta 通道先行。

### 阶段 B2：去 DSH 宿主（原 B 的高风险部分，排在 C 之后）

目标：app 进程树里不再有 DSH Host；自有引擎接管启动、生命周期与发布链。

- 前置：C 完成（循环、工具、会话、审批、用量已自有）；C0 的依赖清单与契约层可用。
- 内容：自有引擎入口（替换 `app/src/host.mjs` 的 `runProfile`）；插件装配不再经 cordis profile；安装器与自动更新链自建；DSH 从安装包里消失。
- 验收：进程树无 DSH Host；真实安装包冷启动、升级、回滚通过；发布链（含 npm Trusted Publishing）可用。
- 说明：B2 从原 B 拆出后顺序为 **A → B1 → C0 → C → B2 → D**（2026-10-23 已拍板）；B2 以 C 完成为前置，不再考虑把 B2 并入 C 之前的方案。

### 阶段 C：自有 Agent 循环（C0 + 6-12 个月，风险最高；2026-10-23 重估）

目标：turn 不再由 DSH Session 执行；至此与 DSH 代码脱钩（只借鉴设计，不再 merge 代码）。

#### C0：可执行性前置（6-10 周；关键路径 6-8 周，C 的 gating）

C 的真实范围是重建 DSH Host 服务层，不是只写循环。动 C 之前必须先有以下产物，否则「3-6 个月 + 兼容垫层」不成立：

- **DSH 依赖清单（已完成，2026-10-23）**：见 [`docs/dev/c0-dsh-dependency-inventory.md`](../dev/c0-dsh-dependency-inventory.md)。实测：`src/host` 204 处 `ctx.*`（39 文件）、`inject` 8 服务、`ctx.get` 19 服务 / 35 次、DSH 事件 14 名 / 31 次（11 核心 + 3 可选）、`ctx.effect` 26 处、工具实体 26 个、3 处 `ctx.plugin` 挂载 + 2 个 `loader.import` 目标、2 条 HTTP 路由；逐项给出 call site、用途、自有方案、替代等级 E1-E3 与风险。**口径修正**：原稿「17 个 ctx.get」「11 个事件」按实测更新为 19 / 14（11 核心 + 3 可选）。
- **`rt.host` 契约层**：把 204 处 `ctx.*` 收敛到一个适配层（dsh adapter / own adapter 两实现），后续切换只改实现。范围除服务 / 事件外，**必须包含** Agent / Session 对象面（`agent.inbox` 26 处、`session.append/seq/header` 等）、中间件顺序（`{prepend:true}` 6 处与注册序、`next()` 语义）、effect / dispose lifecycle（含 async disposer 与 LIFO）、`ctx.fiber` 这类隐藏运行时态。
- **零语义薄替代（新增，与契约层并行或更早）**：40/93 测试文件（≈483/820 例）在 import 阶段就依赖 `@deepseek-ai/*`（`index.js` 与 `src/host` 顶层 import `dsh-llm` / `dsh-tools`）。先做 `createUserMessage` / `BlockAssembler` / `defineTool` / `WebError` 的最小结构等价实现，否则 C 一开始就被 import 卡死。
- **契约化测试**：`test/fake-ctx.js` 只覆盖注册面，不提供 sessionController / sessions / sessionTitle / workspaceRegistry 语义；30 个契约文件各自内联 20 个服务的 fake。抽 `fake-host` 后按 L1/L2/L3/L4 分层迁移（L1 纯逻辑 53 文件 / ≈337 例可直接迁移；L2 契约 29 / ≈388；L3 语义耦合 10 / ≈91 需薄替代与词汇映射；L4 端到端保留为双跑）。
- **双跑 golden master**：现状只有手工对照——`smoke.mjs --out` 产出归一化 JSON，但**无 golden 基线、无 diff 工具、CI 不跑 smoke**；`bench.sh` 依赖 POSIX `sh` / `setsid` 与 `deepseek-harness` checkout，**本机 Windows 不可执行**。C0 必须交付：Windows / CI 可执行入口、基线、`dev/golden-diff.mjs`（归一化 + step diff + mask 规则 + 差异报告）、mock 补 OpenAI 线序、场景补审批 / 压缩切换 / 崩溃恢复 / usage。
- **数据与崩溃设计**：DSH 会话格式当前 v4，迁移链 v0→v4；v1→v2、v2→v3 会**改事件数与序号**，而 `chat-index` / `usage` 的 `through` 是 DSH 事件 seq、`state.json` 以 sessionId 为键——C0 必须冻结「id 不变 + seq 单调度量」不变式，并交付重算 / 回填工具与导出快照的回滚窗口；崩溃恢复与可观测性（日志、监督重启、指标）同批设计。
- **C0 验收**：依赖清单评审通过；零语义薄替代让 40 个 import 依赖文件脱离 DSH 包；契约层让 836 例测试在 fake-host 上全绿；双跑脚本一键出差异报告（差异=0 才进入 C1）。
- **估时与口径（2026-10-23 拍板）**：原「≤4-6 周」不成立——仅测试 / 数据侧就 30-41 人日。走**关键路径 6-8 周**口径：保零语义薄替代、fake-host、事件词汇、双跑入口与 diff 工具；数据面 version 链与 JSONL fixture 降为 C2 前置；双跑场景先做审批 + 压缩，其余在 C1-C6 补。全量 6-10 周作为备选，不作为当前计划。

#### C1-C6（在 C0 上执行）

- **C1 循环本体**（`src/host/loop.js`）：messages → 流式请求（阶段 A 的自有客户端）→ 工具调用 → 执行 → 回填 → 续跑；支持中止、失败重试与 `turnFailure` 分类（`turns.js` 现成）；对齐 C0 的事件契约。
- **C2 会话存储**：自有 JSONL（对齐 `dsh-session-persistence-jsonl` 的设计；`parts.js` 的分段模型已在上层）；**包含** DSH 会话数据的迁移/replay 与格式版本链，不只「对齐设计」。
- **C3 工具面**：自有实现文件读写 / 搜索 / Shell（pwsh、bash，带审批）+ **后台 jobs**（长命令与服务，最小集最容易漏）+ `working_directory` 语义 + `read_browser`；`approvals.js` 的审批请求改走自有通道；**补齐 `restrict` / `guard` / 超时 / 截断 / spill / 输出保留 / 并发分类语义**，并对齐 DSH 工具流水线（`tools/pre-execute` → guard → execute → post-execute → finalizeContent → tools/result；未知工具与异常返回结构化错误但不结束轮次）；保留 `exec.concludeTurn`、`steer/followup` 两级队列与 `tool/ptc-dispatch*` 等价事件。**浏览器桥不是 CDP**：`read_browser` 依赖 DSH Desktop 壳的 Electron webview 租约（`window.dshDesktop.browser.acquire`）与自有长轮询，自有 `app/` 未提供该桥——B1 启用自有 UI 时须自建壳桥（preload + webview/WebContentsView + IPC + 每 Bot partition），C3 保留自有通道。MCP / skill / 连接器生态按「独立化前置」三档处理（MCP 用中立 SDK 自研薄桥、skill 自有实现、DSH 引擎与界面插件终止）。
- **C4 上下文管家**：`steward.js` + `parts.js` 的策略已经自有，其摘要调用在阶段 A 已切到自有客户端；补齐循环内的分段切换。
- **C5 用量**：`usage.js` 从 DSH 会话事件改收自有循环的 usage chunk（`record()` 已存在）。
- **C6 测试策略（2026-10-23 修正）**：seam 是语言级的，不是架构级的——836 例经 `test/harness-resolve.mjs` 解析到 DSH 包，`fake-ctx.js` 只覆盖注册面，30 个契约文件内联了各自的服务 fake。C0 先做零语义薄替代 + `rt.host` 契约层 + `fake-host`，再按 L1/L2/L3/L4 分层迁移：L1 直接迁移、L2 换 fake-host、L3 薄替代 + 词汇映射、L4 升级为双跑；双跑差异=0 是切换判据，不做大爆炸重写。
- **验收（量化）**：双跑差异=0 的场景数（覆盖群聊、派活、记忆、审批、压缩、迟到回复，**以及工具面：取消、审批超时、spill 恢复、restrict 生效时机、长结果截断**）；审批 / 重试 / 中止 / 压缩 / 用量与 DSH 对齐；崩溃恢复演练通过；836 例在自有基底上全绿或等价覆盖。
- **重估理由**：原清单只算 loop + 5 项，未算 DSH Host 服务层与生态替代；且「顺带解决上游软肋」（群轮次纯内存、下游等待无超时、防泄漏列举式闸）是加范围，不加工期。单人 + 每周上游跟进下按 6-12 个月计。

### 阶段 D：移动端（约 1-2 个月）

目标：手机平板可用，复用同一后端与 `api/bot` 协议。

- **D0 可行性验证（先行，1-2 周）**：现有 web 形态 + B1 的局域网出口，用手机浏览器跑通核心链路（聊天、@ 派活、审批），复用上游 dev 已有的窄屏 / 触控 / viewport 成果；验证通过再投 Capacitor。
- **D1 路线（拍板：Capacitor）**：把 app 客户端（`app/ui` 线，约 700 行 React 壳 + 复用插件视图）用 Capacitor 打包成 iOS / Android app；同一 SPA 加响应式布局（触控、视口、窄屏导航）。不选 PWA（无推送、iOS 限制多）与 RN/Flutter（重写成本高）。
- **D2 网络与安全**：依赖 B1 的局域网绑定 + token 认证；**明确安全模型**：配对码 / 短时可吊销 token / 权限分级，建议 TLS 或 SSH 隧道；处理 `api/bot` 相对路径（Capacitor origin 是 `capacitor://localhost`）、CORS、iOS ATS 与 Android cleartext 限制、端口发现、前台恢复补拉。桌面与移动同后端。
- **D3 范围**：聊天读写、@ 派活、审批、Bot 管理可用；后台推送不做（已知限制）。**移动端是 thin client：手机必须连到运行中的桌面端、同一可信网络，桌面休眠即不可用**——这一条写进 README 与「已知限制」。
- **验收**：真机（iOS + Android 各一）跑通核心链路；窄屏无横向滚动；断线重连与 token 吊销生效。

## 独立化前置（2026-10-23 新增，独立发布 blocking）

以下五块不属于某个阶段的功能开发；2026-10-23 已拍板处理方式，按对应阶段执行：

- **账号（OAuth）（2026-10-23 已拍板）**：B1 保留 DSH 账号服务（`dsh-deepseek-account` / `dsh-llm-deepseek-account` 继续在 `dsh-base` profile 里），自有 UI 复刻登录入口（登录仍走 DSH 的 OAuth 流程与 loopback 回调）；C0 产出「自研 OAuth / token 服务」评估（含 `auto` 联网搜索的账号 token）作为 C 的 gating 输入，C 阶段实施自研；若 C0 评估成本不可接受，保底方案 = 弃用账号登录 + API key 迁移引导（README / CHANGELOG 前置声明）。B1 发布阻断项：纯账号用户的升级路径必须在发布说明里写清。
- **数据**：现有历史在 DSH JSONL 格式（v0→v4 迁移链）。C2 必须含导出 / 导入、自有格式版本链与回滚窗口；B2 前定义新 home 布局（`DSH_HOME` 概念随 DSH 退出历史）；安装包升级不得丢历史会话。
- **发布身份（2026-10-23 已拍板）**：appId 改为 `io.github.miasakiii.dsbot`；publish owner 与 `app/src/updates.mjs` 更新源改为 fork（`Miasakiii/DeepSeek-Bot`）；Windows 沿用只装当前用户、不签名（SmartScreen 提示保留），macOS 沿用 ad-hoc 签名 + zip（新版提示下载）；产品名暂保留「DS Bot」，商标 / 品牌名归 B1 UI 阶段定；NOTICE 与作者信息同步更新。**改 appId 意味着更新断代**：独立版首次发布要求用户卸载旧版后重装，发布说明写明迁移步骤；electron-updater 不能降级，保留 N-1 回滚兼容。
- **发布链**：B1 起安装 / 更新链逐步脱离上游 `release.yml` 模板；npm Trusted Publishing 必须先在 npmjs.com 给新包名 `miasaki-dsbot` 配好（否则 OIDC 发布失败）；beta / stable 通道与回滚策略同时定。
- **插件生态（2026-10-23 已拍板三档）**：① **MCP 兼容（保留）**——用中立的 `@modelcontextprotocol/client`（`dsh-mcp-client` 的底层依赖，MIT）自写薄桥（`mcp__server__tool` 命名、schema 转换、60s 超时、重连退避、stdio 审批、spill 兼容）；② **skill 兼容（自有实现）**——降级为本地目录 / 内置提示词 + 按需加载；③ **DSH 引擎插件与界面插件（终止）**——界面插件在 B1 后不可用，引擎插件在 C 后不再加载，PTC 呈现模式放弃但为旧群 Session 留兼容 shim。README / CHANGELOG 按这三档向用户交代，避免「兼容插件生态」承诺断裂。

## 上游同步策略（2026-10-23 新增）

- 原「1.2 天/版」口径需修正：历史均值约 1.2 天成立，但最近一版间隔 4.66 天；实际 merge 成本由 dev 提交量驱动（上游 dev 约 2.2 天累积 100 提交，fork main 落后约 100 提交）。
- **C 动工前**做最后一次 `upstream/dev` merge，只取 `ds-bot/` 与 `docs/plans/`（`app/` 从 B1 起不再同步，自有引擎方向在 B1 决策）；之后冻结代码同步。
- **C 期间**只 cherry-pick 安全与数据损坏修复，不跟新特性。
- **B1 之后**放弃上游 `app/` 代码同步，只保留 `ds-bot/` 的设计借鉴；把每周 1-2 天跟进计入资源预算。

## 取代与待改的既有设计（2026-10-23 新增）

解耦主线会推翻以下已定设计，逐条列负责阶段，避免「悄悄作废」：

| 文档 / 位置 | 现有结论 | 何时失效 / 改法 |
|---|---|---|
| vision.md / vision.zh.md L9、L13-18、L22、L30、L35 | built on DSH；两种形态；独立 app「少让步」 | B1 后两形态变三形态，C 后 built on DSH 失效；按 B1 / C 完成点分阶段改 |
| README.md / README.zh.md、known-issues | 安装方式、包名、DSH 限制条目 | B1 / C 后更新；known-issues 中 DSH 限制条目随阶段失效删除或标注 |
| desktop-app.md L12 | 引擎用 DSH，不另写 Agent 运行时 | C 取代 |
| desktop-app.md L13、L105 | 界面用 DSH 网页前端；app/ui 不安装不打包 | B1 取代 |
| desktop-app.md L39 | 模型服务商和 key 在 DSH 设置里配 | A 起逐步迁到自有目录；账号路由见「独立化前置」 |
| desktop-app.md L94、L113 | 安装包带完整锁定 DSH | B2 后重定 |
| dsh-concessions.md「桌面应用之后」列（C1-C14） | 按「有 DSH profile」写 | B1 / C 后整列重写，逐条标阶段 |
| AGENTS.md Hard rules 1、CONTRIBUTING.md / zh 第 1 条 | Build on DSH; never patch it；不要另加 agent 运行时 | 2026-10-23 已改为阶段限定（C 前只用公开 API，C 起自有运行时） |
| plans/README.md 目录 | 未收录本文 | 2026-10-23 已补 |
| browser-and-secrets / context-and-memory / long-messages 的数据路径 | `bot/secrets.json`、`bot/memory/`、`bot/group-lines/` | 2026-10-23 改名收尾时已同步为 `miasaki-dsbot/` |
| release-checklist.md | 上游流程（DSH Desktop 安装、`~/.dsh/` 备份） | B2 重写 |

## 不做什么

- 不给 DSH 打补丁、不依赖 DSH 安装目录内的文件；只用文档化插件 API（`registerAdapter` 是其一）。若开动前发现 `registerAdapter` 实为内部 API，回退「镜像方案」（自有目录仍写回 DSH settings 以让循环服务路由），阶段 A 收益缩水为「自有目录 + 自有密钥 + 自有协议客户端只服务辅助调用」，并在本文「变更」记录。
- 不做 React Native / Flutter 重写。
- 不在阶段 A 之前动 agent 循环、会话存储、工具面。
- 不改 client 的 `api/bot` 协议（移动端直接复用）。
- 阶段 A 不重写 DeepSeek 账号 OAuth 路由。
- **B1 不宣称「app 里没有 DSH」**；「无 DSH 进程」不是解耦判据。
- **C0 完成前不动循环重写**；不在 C0 验收前承诺 C 的工期。
- 不把「去网页前端」和「去运行时」混进同一个里程碑。
- 独立发布身份（appId / 更新源 / 签名 / 商标）定死前不发布「独立版」。
- C 完成前不宣称「完全解耦」，也不承诺历史会话迁移已完成（数据迁移单独验收）。

## 已知限制

- 阶段 C 是全程可靠性风险最高的一步：工具审批、失败重试、压缩时机的边角 DSH 打磨已久；自有循环必须有等价测试覆盖才上线（C0 的双跑 diff 是门槛）。
- B1 期间 DSH 运行时仍在，真正去 DSH 在 C / B2；这期间 DSH 升级仍可能影响 ds-bot 与自有 UI 的接口。
- 账号与发布身份已拍板（见「已定决策」）；数据迁移与插件生态的实施按阶段推进。B1 只发 beta，不能发「独立软件」正式版——正式版要求 C0 的账号评估结论、数据迁移方案与发布链就绪。
- DSH 界面插件生态在 B1 后不可用；MCP / skill 生态在 C 后需替代或明确放弃（见「独立化前置」）。
- 双形态（DSH 插件 + app）在 C 前并存，配置双源、传输双通道要同时维护。
- 移动端是 thin client（手机连桌面后端），不是手机独立运行；后台推送不做。
- 单人维护 + 上游约 2.2 天 100 提交：C 期间必须冻结代码同步，否则冲突成本随重写进度上升；bus factor 为 1。
- 工作量总估（2026-10-23 修订）：A 2-4 周、B1 4-8 周、C0 6-10 周（关键路径 6-8 周；原「≤4-6 周」不成立，仅测试 / 数据侧就 30-41 人日）、C 6-12 个月、B2 1-2 月、D 1-2 月；每阶段独立可发布，但「独立软件」正式发布受「独立化前置」阻塞。
- 上游已知软肋（群轮次状态纯内存崩溃丢本轮、下游等待无超时、防泄漏为列举式闸）在阶段 C 顺带解决，不提前。

## 已定决策（2026-10-23 拍板）

决策依据：2026-10-23 评审与 C0 盘点。改动这些决策按 CONTRIBUTING 的 maintainer 流程。

1. **阶段顺序**：**A → B1 → C0 → C → B2 → D**。B1 去前端（DSH Host 保留），C0 是 C 的 gating，C 换循环，B2 去宿主，D 移动端。
2. **B1 运行时形态**：**保留独立 Host 子进程**（现结构，只换入口；风险最低）。内嵌 DSH 库与「自有 server 跑在 DSH Host 内」不采用。
3. **账号路线**：**B1 保留 DSH 账号服务**（`dsh-base` 里的 `dsh-deepseek-account` / `dsh-llm-deepseek-account`）并在自有 UI 复刻登录入口；**C0 评估、C 阶段自研 OAuth / token 服务**（含 web-search token）；若 C0 评估成本不可接受，回退「弃用账号登录 + API key 迁移」。
4. **发布身份**：appId → `io.github.miasakiii.dsbot`；发布 owner / 更新源 → fork；Windows 不签名、macOS ad-hoc；产品名暂留「DS Bot」；接受首次独立发布更新断代（用户卸载重装），发布说明写迁移步骤。
5. **插件生态**：**MCP 保留**（中立 `@modelcontextprotocol/client` 薄桥）；**skill 自有实现**；**DSH 引擎插件与界面插件终止**（PTC 呈现放弃，留旧群 Session 兼容 shim）。
6. **C0 口径**：走**关键路径 6-8 周**；数据面 version 链与 JSONL fixture 降为 C2 前置；双跑场景先做审批 + 压缩，其余在 C1-C6 补。

## 变更

- 2026-10-22：建立本文；顺序 A→B→C→D 拍板；`registerAdapter` 使能点确认；移动端定 Capacitor；测试策略定「兼容垫层 + 渐进重写」。
- 2026-10-23：评审后修订。修正事实断言（app/ui 未启用、`config` 实为 29 处/19 键、`handle()` 未导出且依赖 DSH、StreamChunk 词表、上游节奏口径）；新增 B1/B2 拆分与 B1-0 运行时形态决策；新增 C0 前置并把 C 重估为 6-12 个月、验收改为双跑差异=0；新增「独立化前置」「上游同步策略」「取代与待改的既有设计」；A 补迁移防撞与客户端接线，A5 改为复用现有 mock；D 补 thin-client 限制与安全模型。阶段顺序调整与六项决策同日拍板（见上条）。
- 2026-10-23（C0 盘点）：完成 [`docs/dev/c0-dsh-dependency-inventory.md`](../dev/c0-dsh-dependency-inventory.md)。实测服务 19 / 事件 14（11 核心 + 3 可选）/ 工具实体 26 / 测试分层 53-29-10 / DSH 会话 v4 迁移链 / 双跑资产缺口；据此修正 C0 估时（6-10 周，原 ≤4-6 周不成立）、C3 浏览器桥（非 CDP，B1 须自建壳桥）、补零语义薄替代与 MCP / skill / DSH 插件三档生态口径。
- 2026-10-23（决策拍板）：六项待拍板事项按评审建议拍板，写入「已定决策」——阶段顺序 A→B1→C0→C→B2→D；B1 保留 Host 子进程；账号 B1 沿用 DSH 账号服务、C 自研 OAuth（C0 评估、含保底方案）；发布身份改 fork 自有 appId（`io.github.miasakiii.dsbot`）与更新源；插件生态 MCP 保留 / skill 自有 / 引擎与界面插件终止；C0 走关键路径 6-8 周。本轮只更新规划文档，不动代码。
- 2026-10-23（发布身份与改名收尾实施）：按上条决策落地代码面——插件包名 / 插件 id / 数据目录改名完成（旧 `bot/` 一次性迁移到 `miasaki-dsbot/`，另一个 dsh 正占用时改用自有新目录）；appId 改 `io.github.miasakiii.dsbot`，publish owner、更新源（`app/src/updates.mjs`、`electron-builder.yml`、`ds-bot/package.json`）与 NOTICE / 作者信息改到 fork；用户文档（README 中英、known-issues 中英、release-checklist、docker README）与 CHANGELOG 同步。剩余：npmjs.com 上给 `miasaki-dsbot` 配 Trusted Publishing（运营操作）。
- 2026-10-24（口径复核，不改设计）：测试基线 832→836 例（831→835 过，home-move.test.js +4 例）；测试文件 92→93；import 阶段依赖 DSH 的测试 39→40 文件（home-move 经 `../index.js` 依赖闭包计入）。改名收尾提交于 `chore/rename-miasaki-dsbot`，NOTICE 改为与上游并列署名。

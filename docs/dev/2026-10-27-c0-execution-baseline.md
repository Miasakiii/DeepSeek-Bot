# C0 执行基线：切片计划与复核数字

- 日期：2026-10-27
- 相关：[解耦设计](../plans/2026-10-22-decouple-from-dsh.md) §C0（验收四条与关键路径口径）；[C0 依赖清单](c0-dsh-dependency-inventory.md)（2026-10-23，本文的复核对象）；[ROADMAP §四](../../ROADMAP.md) 阶段 C0；[borrowings §4.8](../plans/2026-10-27-personal-agent-borrowings.md)（C0 期间可并行的切片）；[proactivity](../plans/2026-10-26-proactivity.md)（P0/P1 的 state 新字段）
- 性质：本文把 C0 从「依赖清单已完成」推进到「可开工的执行基线」——清单落成四个切片（C0.1–C0.4），每片给出改动落点、开工/完成判据、估时、依赖与风险。**不是新设计**：所有行为口径以解耦设计为准，本文只做切分、排序与数字复核；与解耦设计冲突之处以它为准并在 §一 标注。

## 一、定位与输入

C0 是 C 的 gating（解耦设计 §C0：「没有 C0，C 的『3-6 个月』不成立」）。2026-10-23 拍板的六项决策里第 6 条定了 C0 的口径：**关键路径 6-8 周**；数据面 version 链与 JSONL fixture 降为 C2 前置；双跑场景先做审批 + 压缩。本文即按该口径把清单 §十 的工作项组织成四个可开工、可验收的切片，并与解耦设计 §C0 的产物清单逐条对应：

| 解耦设计 §C0 的产物（2026-10-22-decouple-from-dsh.md:106-113） | 本文对应 | 状态 |
|---|---|---|
| DSH 依赖清单（:106） | 输入；本文 §二 复核其数字 | 已完成（2026-10-23），复核见 §二 |
| 零语义薄替代（:108） | **C0.1** | 未开工；范围较清单扩大（阶段 A 新增 LlmAdapter 面，见 §二） |
| `rt.host` 契约层（:107） | **C0.2** | 未开工；`index.js:82` 的 `createRuntime`/`rt` 对象与 37 个 MODULES 的 `install(rt)` 模式（`index.js:54`）是其现成锚点 |
| 契约化测试（:109，L1-L4 分层） | **C0.3** | 未开工；分层基数按本次闭包实测更新 |
| 双跑 golden master（:110） | **C0.4** | 未开工；清单 §九「mock 补 OpenAI 线序」缺口已被阶段 A 关闭（实测，见 §二） |
| 数据与崩溃设计（:111） | **不在本文切片**：version 链与 JSONL fixture 按决策 6 降为 C2 前置；「id 不变 + seq 单调」不变式收进 §四 红线；该行还要求「交付重算 / 回填工具与导出快照的回滚窗口」——决策 6 的降级清单未点名此项，本文按「随数据面工作包降 C2」处理（理由：C0 的写回走 DSH 自有 append、seq 语义不变，重算需求只在 C2 自有格式迁移时出现；`chat-index` / `usage` 可整表重建，清单 §8.1 已记），归属请随评审确认（§七.4）；崩溃恢复与可观测性的设计落点待确认（见 §七.3） |

范围之外（红线，§四）：C0 不动循环重写；数据面 version 链不进 C0。

## 二、本次复核基线（2026-10-27 实测）

背景：0.2.2 上游已并入（merge 提交 `eb7df8a`，2026-10-25），其后 fork 又落了 B1 出口/自有窗口/DeepSeek 登录等切片；阶段 A 的自有 LLM 层（`src/host/llm.js`）与 0.2.2 的浏览器接管（`src/host/browser/`）都在清单完成之后进的主线，数字漂移是预期内的。以下数字全部为本次实测，命令见 §附。

### 2.1 测试基线

| 项 | 清单口径（2026-10-23/24） | 本次实测（2026-10-27） | 差异原因 |
|---|---|---|---|
| 测试文件数 | 93 | **117** | 0.2.2 合并（browser 接管、side、message layout 等）+ B1/账号切片 |
| 静态 `test()` 声明 | 820 | **1114** | 同上 |
| runner 例数 | 836（835 过 / 1 跳） | **1133（1132 过 / 1 跳 / 0 失败 / 11.7s）** | 同上；任务给的「1133 量级」经实跑确认 |
| import 阶段依赖 DSH 包的测试文件 | 40 / 93（≈483/820 例） | **53 / 117（677 / 1114 静态例，≈61%）** | 分子分母都涨；闭包算法见 §附 |
| 其中直接 import `@deepseek-ai/*` | –（未单列） | **4 个文件**：at-menu、browser-plugin-output、mock-wire、web-search | 0.2.2 新增 browser-plugins/at-menu 面 |
| 用 `fakeContext` 的测试文件 | 29（口径为「契约文件」） | **39** | 同上 |
| `test/fake-host.js` / `src/host/rt*` | 不存在 | **仍不存在**（实测 ls） | C0.2/C0.3 未开工 |
| `dev/harness` 钉版 | `dsh@0.2.1-rc.2` | **仍 `0.2.1-rc.2`**（上游 0.2.2 发布本身未 bump，实测 `git show 48e48fa:ds-bot/dev/harness/package.json`） | 测试基线仍跑在 0.2.1-rc.2 包上；插件包版本已是 0.2.2（`ds-bot/package.json`） |

### 2.2 宿主耦合面（`src/host`）

| 项 | 清单口径 | 本次实测 | 差异原因 |
|---|---|---|---|
| `ctx.*` 调用 / 文件 | 204 处 / 39 文件 | **255 处 / 41 文件（共 55 个 js 文件）**；顶层 227 处 / 36 文件，`browser/` 子目录 28 处 / 5 文件（子目录共 8 个 js 文件，其中 3 个无 `ctx` 调用） | 0.2.2 新增 `src/host/browser/`（8 文件）；清单口径未含子目录 |
| `inject` 硬依赖 | 8 服务 | **不变**：`llm, tools, systemPrompt, sessionController, sessions, sessionTitle, workspaceRegistry, connection`（`index.js:48`） | – |
| `ctx.get` 服务 | 19 名 / 35 次 | **21 名 / 45 次**；新增 `deepseekAccount`（3 次）、`webServer`（1 次） | B1 的 DeepSeek 登录切片新增 `src/host/account.js`（`account.js:32/38/71`、`account.js:52`） |
| `ctx.on` 事件 | 14 名 / 31 次（11 核心 + 3 可选） | **16 名 / 34 注册（11 核心不变 + 5 可选）**；可选新增 `credentials/record-updated`、`deepseek-account/signed-out`（`models.js:20` 的循环注册） | 阶段 A 自有目录/密钥库的事件失效面扩大 |
| `ctx.effect` | 26 处 | **31 处 / 24 文件** | 新增 `account.js`、`outlet.js`、`browser/mount.js` 等 |
| effect「不清会坏」关键点 | 7 处 | **仍 7 处，行号更新**：`store.js:336`、`capabilities.js:426/499`、`parts.js:298`、`diagnostics.js:125`、`resume.js:386`、`usage.js:274`、`chat-index.js:127` | – |
| `ctx.llm` | 19 次 | **27 次**：`stream`×9、`resolveModelInfo`×7、`listConfigurableProviders`×5、`registerAdapter`×2、`listProviders`×2、`listModels`×1、`discoverModels`×1 | A3 自有适配器注册（`llm.js:811`）；初版误写总数 24，2026-10-27 复核修订更正（分解无误） |
| `ctx.tools` / `ctx.workspaceRegistry` / `ctx.sessionController` / `ctx.sessions` | 30 / 21 / 10 / 9 | **31 / 21 / 11 / 10**（`ctx.tools`：`register`×26、`schemas`×2、`restrict`×2、`guard`×1，含 0.2.2 新增的 `browser/mount.js`） | 微涨 |
| `ctx.plugin` 挂载 / `loader.import` | 3 处 / 2 目标 | **不变**（`capabilities.js:310` 一行两处、`connectors.js:78/86`；`dsh-mcp-client`、`dsh-app-boot`） | – |
| `prepend: true` | 6 处 | **不变**：`approvals.js:48`、`parts.js:1052/1109/1140/1151`、`time-context.js:45` | – |
| `ctx.fiber` 隐藏运行时态 | `parts.js:738` | **仍 1 处，行号更新为 `parts.js:748`**（`ctx.fiber?.uid === null` + `/in inactive context/`） | – |
| Agent/Session 对象面 | inbox 26 / followup 6 / requestHeader 5 / deriveMessages 5 / seq 4 / append 1 | **inbox 26 / followup 8 个调用点（grep 9 行，`parts.js:755` 为注释）/ requestHeader 8 / deriveMessages 6 / session.seq（`chat-index.js:55`）+ session.append（`images.js:202`）** | 微涨；对象面结构未变 |

### 2.3 零语义薄替代的 import 面（较清单扩大的部分，C0.1 的直接输入）

| DSH 包 | 导入符号 | call site（本次实测） |
|---|---|---|
| `dsh-llm` | `createUserMessage` | `channel.js:3`、`delivery.js:3`、`groups.js:23`、`parts.js:18`、`time-context.js:1`、`browser/session-model.js:1-7` |
| `dsh-llm` | `BlockAssembler` | `btw.js:10`、`images.js:7`、`memory.js:30`、`parts.js:18`、`browser/session-model.js:1-7` |
| `dsh-llm` | `createAssistantMessage`、`createSystemMessage`、`createToolResultMessage` | `browser/session-model.js:1-7`（**初版表格遗漏此文件**，2026-10-27 复核修订补入；0.2.2 浏览器接管新增，闭包实测 39 个测试文件可达它） |
| `dsh-llm` | `LlmAdapter`、`LlmError`、`assertUsableApiKey`、`attributionHeaders`、`fileHandleText` | `llm.js:11`（**清单没有此项**：`llm.js:699` `class BotLlmAdapter extends LlmAdapter`、`llm.js:811` `registerAdapter` 是阶段 A 落地的运行时契约） |
| `dsh-llm` | `HarnessError`（`memory.js:1088` `class MemoryWriteError extends HarnessError`） | `memory.js:30` |
| `dsh-tools` | `defineTool` | `browser.js:6`、`browser-plugins.js:5`、`groups.js:24`、`memory.js:31`、`secrets.js:8`、`tools.js:4` |
| `dsh-web` | `WebError` | `web-search.js:11` |
| 测试直连 | cordis `Context`、`ToolCallId`、`dsh-system-prompt`、`ToolRuntime/defineTool` | `browser-plugin-output.test.js:3-6`；`dsh-session-reference`（`at-menu.test.js:3`）；`HarnessError`（`web-search.test.js:5`）；`BlockAssembler`（`mock-wire.test.js:8`） |

清单 §四.7 记「DSH 纯函数 import 12 处 / 4 个名字」；本次实测为 **17 行 import / 13 个符号**（`dsh-llm` 11 + `dsh-tools` 1 + `dsh-web` 1），差异来自阶段 A 的 `llm.js` 与 0.2.2 的 `browser/session-model.js`。这是 C0.1 范围变化的实质之一：`LlmAdapter` 是**运行时注册契约**（类继承 + `registerAdapter`），不能像纯函数那样直接换薄实现——处理方案见 C0.1；`session-model.js` 则说明薄替代面必须按 carrier 清单（§附闭包脚本的 carriers 输出）施工，不能只按清单点名的四个名字。

### 2.4 双跑资产现状

| 资产 | 本次实测 | 与清单 §九 的差异 |
|---|---|---|
| `dev/mock-llm.mjs` | 930 行；**三线序齐**：`/v1/messages`（anthropic）、`/chat/completions`（openai）、`/responses`（responses），另有 `GET /v1/models`（`mock-llm.mjs:825-830`） | 「A5 补 OpenAI」缺口**已关闭**（阶段 A 完成）；C0.4 不再含此项 |
| `dev/smoke.mjs` | 451 行；`--out` 归一化转录（`:9`、`:21`、`normalized()` `:86`、`:151`）；顶层 42 个 `await step()`（含循环生成约 44+ 步） | 不变；无审批/压缩场景步骤（只有一条摘要断言 `:332`） |
| golden 基线 / diff 工具 | **不存在**：`ls dev/golden*`、`dev/golden-diff.mjs` 均无；smoke/bench 源码中无 golden 字样 | 不变 |
| `dev/bench.sh` | 138 行；`#!/bin/sh` + `set -eu`（`:1,:14`）；进程组靠 `setsid`（`:40-49,:90-92,:101-104`）；profile 靠 `pnpm install`（`:64`）；`dsh web` 起在 `DSH_HARNESS` **checkout** 内（`:101-104`，硬编码 checkout 内 overlay `apps/web/tests/pin-browse-picker.overlay.yml`）；数据在 `.dsh-test-<name>`（`:24`） | 不变；**本机仍不可执行**：`../deepseek-harness` 与 `<repo>/deepseek-harness` 实测均不存在 |
| `dev/check.sh` | `#!/bin/sh`（POSIX 依赖与 bench 同源） | 清单未单列，一并计入 Windows 入口工作项 |
| CI | `test.yml` 只跑 `npm test` + `--check` + `lint`（`test.yml:39-41`）+ 泄漏扫描；仍不跑 smoke | 不变 |
| npm 路线的可行性证据 | `@deepseek-ai/dsh` npm 包**带 `bin`**（`dev/harness/node_modules/@deepseek-ai/dsh/package.json:14`）；CI 的 harness matrix 已从 npm 装 DSH（`test.yml:38`） | 清单「WSL 还是补 checkout」待确认项的新候选答案，见 C0.4 |

## 三、切片计划

顺序：**C0.1 → C0.2 → C0.3 → C0.4**，其中 C0.1 与 C0.2 可部分并行（C0.2 的接口定稿不依赖 C0.1，但其行为锁定测试需要薄替代先把 import 面清开）；C0.3 依赖 C0.2 的接口与 C0.1 的收口；C0.4 的 tracer bullet 依赖 C0.2 的对象面契约。合计 23-35 人日，与决策 6 的关键路径 6-8 周（含评审、smoke 回归与并行余量）一致。

### C0.1 零语义薄替代

把 §2.3 表里的 DSH import 全部换成**自有结构等价实现**，使测试闭包在 import 阶段零依赖 `@deepseek-ai/*`。

- **改动落点**
  - 新增 `ds-bot/src/host/vendor/`（命名开工时定，下同）：`vendor/messages.js`（`createUserMessage` + `BlockAssembler` + `createAssistantMessage` / `createSystemMessage` / `createToolResultMessage` 的成员面，call site 含 `browser/session-model.js`）、`vendor/tools.js`（`defineTool`）、`vendor/web.js`（`WebError`）、`vendor/llm-errors.js`（`LlmError`、`HarnessError`、`assertUsableApiKey`、`attributionHeaders`、`fileHandleText`）。实现范围 = §2.3 表的 call site 实际用到的成员，逐一审计，不猜 API；施工顺序按 §附闭包脚本的 carriers 清单（14 个 src 载体 + `web-search.js`）走，不按清单点名的四个名字。
  - **拆壳**（清单没有的新工作项）：`src/host/llm.js` 拆成两层——协议客户端/目录/`wireRequest` 等主体移入不 import DSH 的模块；`BotLlmAdapter extends LlmAdapter` + `ctx.llm.registerAdapter`（`llm.js:699/811`）留在唯一保留 DSH import 的薄壳（如 `llm-adapter-shell.js`）。运行时行为不变（同一个类、同一次注册），测试只 import 非 DSH 部分。备选方案是给 `LlmAdapter` 也做结构等价基类——但注册进 DSH registry 的对象若因此改变，违反「不动运行时语义」，不推荐。
  - 测试侧词表映射：`browser-plugin-output.test.js` 的 cordis `Context`/`ToolCallId`/`dsh-system-prompt`/`ToolRuntime` 改用 fake-host 同形供给（与 C0.3 衔接）；`at-menu.test.js` 的 `dsh-session-reference` 两个纯函数做薄替代。
  - CI 守卫：`test/` 目录 0 个 `@deepseek-ai` import；`src/` 白名单（vendor + llm 注册壳）之外禁止新增（实现位置待定，见 §七）。
- **开工判据**：无前置，可立即开工；本文与清单一并送评审。
- **完成判据**：闭包脚本输出 `import-stage DSH-dependent files: 0`（§附；「0」的口径含 llm 注册壳例外与否见 §七.2——注册壳若仍被测试触及，字面 0 不可达，届时以 §五 验收 2 的口径为准）；`npm test` 1133 例全绿 + `--check` + lint；CI 守卫生效。
- **估时**：3-5 天（清单 #5 原估 2-3 天 + `LlmAdapter` 拆壳 + 测试词表映射）。
- **依赖**：无。
- **风险**：`BlockAssembler`/`LlmAdapter` 成员面靠 call site 审计，漏一个方法就是运行时错——用「先审计后实现」+ 全量测试 + smoke 兜底；拆壳动阶段 A 刚落地的文件，必须过 `dev/smoke.mjs`；薄替代必须是**原创**实现（观察行为、不读抄 DSH 源码，AGENTS.md 硬规则 3）。

### C0.2 `rt.host` 契约层

把 255 处 `ctx.*` 收敛到一个双实现适配层（`rt/dsh.js` = DSH 薄包装；`test/fake-host.js` = 契约 fake），后续切换只改实现。**C0 阶段只定义接口 + DSH 实现 + fake 实现，不实现自有运行时**（那是 C 的事）。

- **改动落点**：新增 `src/host/rt/`（`rt/host.js` 接口 + `rt/dsh.js` DSH 实现）、`test/fake-host.js`（fake 实现，供 C0.3）。现有 `createRuntime` 的 `rt` 对象（`index.js:82-103`）是挂载点。范围**必须含**以下五面：
  1. **服务面**：`inject` 8（`index.js:48`）+ `ctx.get` 21 名 / 45 次（§2.2）+ `ctx.inject` 动态 4 处（`btw.js:71` sessionProjections、`schedules.js:80` schedule、`secrets.js:572` shellEnv、`tools.js:751` goals）。
  2. **事件面与中间件顺序**：11 核心事件 + 5 可选事件名；顺序语义 = 默认注册序（MODULES 序，`index.js:54`；usage 的计量中间件因此排最后）+ `prepend: true` 6 处（§2.2）+ **`next()` 链语义**。现状的 `fake-ctx.js:54` 明确「不跑 middleware」——契约必须把 waterfall 定为一等语义。行为以对 `dev/harness` 的**行为锁定测试**为准（放 `dev/contract/`，有 harness 才跑），不照文档猜。
  3. **Agent/Session 对象面**：`agent.inbox`（26 处：nextStep/nextTurn/prepend）、`agent.ctx`（8）、`agent.followup`（8 个调用点）、`agent.session.append`（`images.js:202`）、`agent.session.seq`（`chat-index.js:55`）、`session.header`、`session.requestHeader`（8）、`session.deriveMessages`（6）。
  4. **effect/dispose lifecycle**：`ctx.effect` 31 处（24 文件），契约含 **async disposer 与 LIFO**（现状 `fake-ctx.js:60-68` 只支持同步 disposer——execute 返回 Promise 时 disposer 会丢，这是 fake-ctx 的实测缺口）；7 处关键 disposer（§2.2）作为契约用例。
  5. **隐藏运行时态**：`ctx.fiber?.uid === null` 与 `/in inactive context/` 判定（`parts.js:748`）——契约表达为「卸载期错误」的等价谓词函数，不复刻 cordis 内部。
  另含工具注册面（`ctx.tools` register×26 / schemas×2 / restrict×2 / guard×1，31 处）与 `connection` 路由面（`channel.js`/`feed.js` 2 条）。
- **开工判据**：本文评审通过；C0.1 的 vendor 面定型（并行过半即可）。
- **完成判据**：五面接口成文（JSDoc/类型）；`rt/dsh.js` 过 `dev/contract/` 行为锁定测试；fake-host 按接口可跑通 L2 抽样（与 C0.3 合并验收）。
- **估时**：5-8 天。
- **依赖**：C0.1。
- **风险**：cordis 边角语义（`fiber.await` 超时、plugin 重挂、prepend 与 next 的组合序）只能在锁定测试里逐个钉住，漏钉的到 C 才暴露；范围蔓延——接口只收 src/host 实际用到的成员，不预先设计 DSH 全表面。

### C0.3 fake-host 抽取与契约化测试分层迁移

- **改动落点**：`test/fake-host.js`（按 C0.2 接口供给 20+ 服务语义默认实现）；`test/fake-ctx.js` 保留为注册面薄壳或废弃（开工时定）；逐文件迁移。分层按本次实测基数：
  - **L1 纯逻辑（64 文件 / 437 静态例）**：不在 DSH 闭包内，C0.1 收口后天然脱离；**5 个 jsdom 测试**（activity-row、read-page、right-panel、sidebar-switch、styles，均经 `dev/harness` 取 jsdom——styles 用 `requireHarness('jsdom')`、read-page 用 harness checkout 的 `createRequire`）的来源改为 ds-bot devDeps（清单 #2 记「3 个」为 2026-10-23 口径，0.5 天估时不变）。每文件迁移台账（清单 #1 的 1-2 天工作项）在此片开工时建立。
  - **L2 契约（39 个 fakeContext 用户文件）**：统一换 `fake-host`；内联服务 fake 逐批退役。纪律：**只换供给不改断言**；断言要改必须单列说明。
  - **L3 语义耦合（直连 DSH 的 4 文件 + 闭包内断言 DSH 词表的文件）**：薄替代 + 词汇映射；逐文件台账开工时清点（清单口径 10 文件/91 例已过时）。
  - **L4 端到端**：smoke、bench、check、ui-shots、memory-e2e、steward-eval、shared-home-check → 留作 C0.4 双跑。
- **开工判据**：C0.2 接口定稿；C0.1 完成（闭包清零）。
- **完成判据**：**在无 `dev/harness` 的环境下 `npm test` 1133 例全绿**（harness 此后只服务 `dev/contract/` 行为锁定与 `rt/dsh.js`）；CI 主测试不再依赖 harness 安装。
- **估时**：7-10 天（清单 #3 + #4 原估 7-9 天；例数基数已从 820 涨到 1114 静态 / 1133 runner）。
- **依赖**：C0.1、C0.2。
- **风险**：fake 服务语义与 DSH 真实行为的偏差被测试固化——用行为锁定测试约束关键语义；大批量迁移掩盖单文件回归——按文件小批提交。

### C0.4 双跑 golden master

- **改动落点**
  1. `dev/golden-diff.mjs`（新）：归一化补全（system prompt / tools 哈希、摘要全文、usage、审批决策、错误分类——清单 §九 的缺口清单）+ step diff + mask 规则 + 人可读差异报告（含非零 exit code，供 CI）。
  2. 基线产出：`dev/golden/<scenario>.json`（归一化转录进 git；格式与命名开工时定）。
  3. **Windows/CI 可执行入口**（清单 #7）：`dev/golden.mjs` 单入口（node `child_process` 管理 mock 与 `dsh web` 两进程；pid 文件 + 进程树终止替代 `setsid` 进程组；不经 sh）。载体三选一：**npm 包路线**（`@deepseek-ai/dsh` 带 bin、CI 已在用 npm harness——§2.4 实测；但 `pnpm --profile --patch` 的 profile 机制需在 node 入口里等价实现，**开工前先 spike 验证**）、WSL、补 checkout。这是清单待确认项，本文给出候选与证据，拍板见 §七。
  4. 场景先做**审批 + 压缩**（决策 6 范围）：审批走 `api/bot` 的审批作答端点；压缩用 `CHECK_RATIO` 驱动切换（`bench.sh:71-73` 已有该旋钮）。mock 补 OpenAI 线序一项**已由阶段 A 关闭**（§2.4），从本片剔除。
  5. tracer bullet：自有 turn 驱动 + `agent.session.append` + `sessions.flush` 写回 DSH 会话、读面全留 DSH（清单 §十一 边界），作为被 diff 的第二实现。它依赖 C0.2 的对象面契约，**不是循环重写**（§四 红线 3）。
- **开工判据**：C0.2 对象面契约可用；双跑载体拍板。
- **完成判据**：一键命令在本机 Windows 与 CI 各产出「DSH 循环」与「tracer bullet」两份转录 + 差异报告；审批与压缩两场景两边可跑；差异=0 作为进 C1 的门槛（解耦设计 §C0 验收）。
- **估时**：8-12 天（入口 3-5 + diff/基线 3-4 + 场景 2-3）。
- **依赖**：C0.2；C0.1（新增场景代码不得新增 DSH import，过 CI 守卫）。
- **风险**：npm 包形态下 profile/patch 等价性未验证（spike 先行，失败则回退 WSL/checkout 路线并重估）；归一化过粗掩盖真差异、过细造成误报——以「人可读差异报告」为验收口径。

## 四、不变式与红线

1. **会话 id 不变**：`bot.sessionId` / `segments[].sessionId` / `room.sessions` / `questions` 以 DSH Session id 为键，Bot id 本是首会话 id（清单 §8.1）。C0 任何切片（含 tracer bullet 写回）不得重生成 id。
2. **seq 单调度量**：`chat-index` / `usage` 的 `through` 是事件 seq（`chat-index.js:55` `Number(agent.session.seq) - 1`，`:148` 有 gap 校验）；写回路径 append 后 seq 必须单调递增；双跑 diff 把 seq 作硬校验。
3. **C0 完成前不动循环重写**（解耦设计「不做什么」）。C0 期间唯一被允许的「自有循环」是 C0.4 的 tracer bullet：只驱动 turn + 写回事件，读面（page/projections/usage/feed/chat-index/search）全部留 DSH。
4. **数据面 version 链与 JSONL fixture 是 C2 前置**（决策 6），不在 C0 任何切片；本文与 proactivity 的 store 新字段处理方式见 §六。
5. **薄替代是原创的结构等价实现**：按观察到的行为写，不复制 DSH 代码/文本（AGENTS.md 硬规则 3）；实现范围 = call site 实际用到的成员。
6. **测试迁移只换供给不改断言**；断言改动必须单列并说明理由。
7. **不 patch DSH、不依赖 DSH 安装目录内文件、测试数据不碰 `~/.dsh` 与用户数据**（`.dsh-test-<name>/`；AGENTS.md 硬规则 1/5）。

## 五、总验收：对齐解耦设计的 C0 验收四条

解耦设计 §C0（`2026-10-22-decouple-from-dsh.md:112`）的四条验收逐条映射：

| # | 验收原文 | 对应切片 | 可执行判据 |
|---|---|---|---|
| 1 | 依赖清单评审通过 | 输入（清单 + 本文 §二 复核） | 维护者评审通过本文 §二 的口径修正 |
| 2 | 零语义薄替代让 import 依赖文件脱离 DSH 包 | C0.1 | 闭包脚本 0 文件（原文「40 个 import 依赖文件」，复核后基线为 **53 个**；「脱离」的口径按测试闭包计，llm 注册壳例外见 §七）+ CI 守卫 |
| 3 | 全量测试在 fake-host 上全绿 | C0.2 + C0.3 | 无 harness 环境 `npm test` 全绿（原文「836 例」，复核后基线为 **1133 例**） |
| 4 | 双跑脚本一键出差异报告（差异=0 才进 C1） | C0.4 | `dev/golden.mjs` 一键在本机与 CI 产出双转录 + 差异报告；审批 + 压缩场景在列 |

注：原文的 836 例 / 40 文件数字以本文 §二 的 1133 例 / 53 文件为准；这正是本文要做的「清单落成执行基线」的一部分——数字漂移不改设计，只改验收的量词。

## 六、并行关系

按 [borrowings §4.8](../plans/2026-10-27-personal-agent-borrowings.md) 的 C0 行：「批次 B 的设计类切片（W-B5/B6/B7）+ W-B1/B2/B3」「T-01/T-11 依赖 store 新字段，可与 C0 数据设计同批迁移」。落在代码上的同批关系如下：

- **设计类切片（W-B5 混合检索、W-B6 入口网关、W-B7 端云 v1）**：以设计为主，C0 期间随时可做。如实标注：W-B6/W-B7 是纯设计文档；W-B5 在 borrowings §4.4 的行内含代码落点 `memory-index.js`（新）与「召回示例通过」判据（估时栏写「设计 2 天」——borrowings §4.8 的「设计类」与 §4.4 行内口径不一），若实施属新文件，不与 C0 切片冲突。
- **store 新字段（W-B1 画像 `state.profile`、W-B2 价值观〔borrowings 决策 6：与 T-01 共用新 state 字段〕，以及 P0 的 `state.goals`/`state.live`、P1 的 `state.proposals`）**：机制上是同一件事——`store.js` 的 state 模板加键 + `adopt()` 补默认，`state.version` 仍为 1（`store.js:96-99` 只认 `version === 1`；proactivity 2026-10-27 最小范围清单的实测与本文一致）。**W-B3 失败复盘不在此批**：其落点是 `memory.js` 的 lesson 记忆（borrowings §4.4），不动 state.json。**C0 数据面已降级 C2 前置（决策 6），所以「同批迁移」的准确含义是「同一个 store.js 批次」（borrowings 决策 6 亦只记「影响 W-B1/B2 的改动面」），不是「依赖 C0 的 version 链」**：W-B1/B2 与 P0/P1 的字段改动合并为一次 `adopt()` 扩展，避免多批小改 state 模板；将来 C2 引入 version 链时从「version:1 + 这些字段」的基线起步，无二次迁移。
- **P0/P1 新代码与 C0 的接触面**：P0 的工具五件照 `tools.js:57-82` 样例用 `defineTool`，P1 的认领回注用 `createUserMessage` 与 `agent.followup`——恰是 C0.1/C0.2 的对象。协调规则：C0.1 落地后，新文件（`goals.js`/`live.js`/`profile.js` 等）一律 import vendor 薄替代、经 rt 取服务；若新代码先于 C0.1 落地，则这些文件自动进入 C0.1 的收口清单（CI 守卫对新增文件同样生效），不存在「并行做完还要二次返工」的灰区。
- **不并行**：W-B4（`ask_bot`）边界裁决未拍板（borrowings §4.4），不排期；批次 C 依赖自有工具面，与 C0 无交集。

## 七、待维护者拍板 / 待确认

1. **双跑入口载体**：npm 包路线（证据见 §2.4）vs WSL vs 补 checkout。本文建议 npm 包路线 + 开工前 spike；若维护者倾向 WSL/checkout，C0.4 估时上浮。
2. **C0.1 拆壳口径**：`llm-adapter-shell.js` 是 C0.1 收口后 `src/` 里唯一保留 DSH import 的业务文件（vendor 之外）。验收第 2 条的「脱离」按**测试闭包**计（53 → 0）；请确认该口径。
3. **崩溃恢复与可观测性**：解耦设计 §C0 有「崩溃恢复与可观测性（日志、监督重启、指标）同批设计」一句，决策 6 只降级了数据面 version 链与 JSONL fixture。本文按任务范围未为其设切片（崩溃恢复场景本就在被裁减的清单 #11 里）；若需在 C0 内补一份设计笔记，另开 docs/plans 短文。
4. **重算 / 回填工具与导出快照回滚窗口的归属**：解耦设计 §C0（:111）要求 C0「交付重算 / 回填工具与导出快照的回滚窗口」，决策 6 的降级清单（version 链、JSONL fixture）未点名此项。本文按「随数据面工作包降 C2」处理（理由见 §一 表：C0 写回走 DSH append、seq 不变，重算需求只在 C2 迁移时出现），请随评审确认；若维护者判其必须在 C0 内交付，在 C0.4 的场景面加「崩溃恢复 + seq 重算」一片并上浮估时 2-3 天。
5. **vendor 目录命名与位置**、**CI 守卫的实现位置**（`scripts/scan.mjs` 扩展 vs `test.yml` 新步骤）、**`test/fake-ctx.js` 保留或废弃**：三个开工时的小决策，不阻塞评审。

## 附：本次复核的实测命令

在 `ds-bot/` 下执行（工作目录=仓库根时先 `cd ds-bot`）：

```sh
# ctx.* 总数与文件数（含 browser/ 子目录）
grep -ro 'ctx\.[A-Za-z_]*' src/host --include='*.js' | wc -l          # 255
grep -rl 'ctx\.[A-Za-z_]*' src/host --include='*.js' | wc -l          # 41
grep -ro 'ctx\.[A-Za-z_]*' src/host/*.js | wc -l                      # 227（顶层口径）
find src/host -name '*.js' | wc -l                                    # 55
# 分类
grep -oh 'ctx\.[A-Za-z_]*' src/host/*.js src/host/browser/*.js | sort | uniq -c | sort -rn
# ctx.get / ctx.on 去重
grep -rEoh "ctx\.get(\?)?(\.)?\('[^']+'" src/host/*.js src/host/browser/*.js index.js
grep -rEoh "ctx\.on(\?)?(\.)?\('[^']+'" src/host/*.js src/host/browser/*.js index.js

# 测试闭包（import 阶段依赖 = 沿静态 import 递归可达任何顶层 import @deepseek-ai/* 的文件）
node "$TMP/c0-closure.mjs"        # 脚本正文见下；输出：117 files / 1114 decls / 53 dependent

# 全量测试（package.json 的 npm test 同命令；npm 无法 spawn 时直接调 node）
node --import ./test/harness-resolve.mjs --test "test/*.test.js"
# 输出（2026-10-27）：ℹ tests 1133 / pass 1132 / fail 0 / skipped 1 / duration_ms 11695
# 2026-10-28 复跑：tests 1133 / pass 1132 / skipped 1 / duration_ms 7205

# 双跑资产
ls dev/golden* dev/golden-diff.mjs     # 均不存在
ls -d ../deepseek-harness ../deepseek-harness 2>/dev/null   # 本机无 checkout
grep -c "^await step(" dev/smoke.mjs   # 42（顶层）；不带 ^ 时为 45（含循环体内缩进的 3 处）
grep -n "bin" dev/harness/node_modules/@deepseek-ai/dsh/package.json
```

闭包脚本（临时文件，不入库；核心逻辑：读文件静态 import，相对路径解析为文件，缓存每个文件「是否可达 DSH import」）：

```js
// c0-closure.mjs — 判定 test/*.test.js 的 import 阶段 DSH 依赖
// fileImportsDsh: 静态 import/export-from '@deepseek-ai/...' 才算（动态 loader.import 目标字符串不算）
// resolveRel: 相对 specifier → .js / index.js；reaches(): 带环检测的传递闭包
// 输出：test files / static test() declarations / import-stage DSH-dependent files（含每文件例数）
// c0-closure3.mjs（复核修订版）另输出 carriers：每个顶层 import DSH 的 src 文件 → 可达它的测试数与包名
```

（完整脚本在 2026-10-27 会话中执行过；正文 60 行，从 `readdirSync('test')` 起遍历，判据函数如上注释。carriers 输出佐证 C0.1 的施工清单：`tools.js`(43)、`groups.js`(42)、`parts.js`(42)、`btw.js`(42)、`llm.js`(41)、`channel.js`(40)、`time-context.js`(39)、`images.js`(39)、`browser.js`(39)、`browser/session-model.js`(39)、`delivery.js`(38)、`memory.js`(38)、`browser-plugins.js`(38)、`secrets.js`(38) 各为载体，另测试直连 4 文件与 `web-search.js`。）

## 变更

- 2026-10-27 复核修订（换人复审后逐条验证采纳）：§2.3 表补 `browser/session-model.js`（初版遗漏：5 个 `dsh-llm` 符号、39 个测试可达；汇总口径改为 17 行 import / 13 个符号）；§2.2 更正 `ctx.llm` 总数 24→27、`ctx.tools` 30→31（附动词分解）、`browser/` 子目录文件数 8→5（含 ctx 的）、`followup` 9 行→8 调用点（剔除注释行）；C0.3 的 jsdom 测试 3→5（实测文件名单）；C0.2 工具注册面 30→31 处；§三 顺序括注的依赖对象 C0.3→C0.1；C0.1 完成判据补注册壳例外注记；§一 表与 §七.4 补「重算 / 回填工具与导出快照回滚窗口」的归属映射（decouple.md:111 要求、决策 6 未点名，本文按随数据面降 C2 处理并送确认）；§六 修正 W-B3（落点 memory.js 的 lesson 记忆，不进 store 批次）与 W-B5（行内含 memory-index.js 代码落点，非纯文档）；§附 smoke 步骤命令补 `^` 锚（42 顶层 / 45 含循环内）。全量测试于 2026-10-28 复跑，1133 例基线不变。

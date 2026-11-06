# dsh-go 借鉴与剩余任务编排：C0 收尾、并行轨道与阶段门槛

- 日期：2026-10-30
- 状态：**规划文档（不是已定设计）**。§二 的采纳/改造项需维护者逐条拍板后，才进 `ROADMAP.md` §七 决策日志或各自的 `docs/plans/` 设计文档；本文不直接承诺实现，也不改任何已定设计。§三 的编排以 [C0 执行基线](../dev/2026-10-27-c0-execution-baseline.md) 的切片划分为准，本文只做排序、补漏与标注对标结论的落点。
- 相关：
  - 设计依据：[与 DSH 解耦](2026-10-22-decouple-from-dsh.md)（A→B1→C0→C→B2→D、各阶段验收、不变式与已定决策）；[C0 执行基线](../dev/2026-10-27-c0-execution-baseline.md)（C0.1–C0.4 的落点/判据/估时）；[A/B1 收尾包](../dev/2026-10-27-ab1-closeout.md)（待用户项 runbook 与质量门）；[ROADMAP.md](../../ROADMAP.md)（决策日志、并行轨道、上游纪律）；[dsh-go 安卓调研](../dev/dsh-go-android-survey.md)（前次 APK 静态调研，提交 `8ca4686`）
  - 并行提案：[主动性基座](2026-10-26-proactivity.md)（P0–P4 待拍板）；[Personal Agent 趋势借鉴规划](2026-10-27-personal-agent-borrowings.md)（W-A/W-B/W-C 批次与 9 条决策单）
  - 调研输入：2026-10-30 工作流的 dsh-go 四面调研（协议客户端 / DS Bot 通道覆盖 / 远程连接 / runtime 与功能生态）。调研对象为只读浅克隆 `bb52f091`（2026-10-29，`--depth 1`）；其行号引用指向该副本，本计划未运行其任何代码、构建或测试。
- 证据口径分三档，逐条标注：**本会话实跑**（命令与输出见 §一，2026-10-30）；**工作区实测**（`git status`、闭包脚本、grep 等，命令随文给出）；**文档行号**（`路径:行号`，含上引调研材料给出的出处）。未跑过的一律写「未跑」，不用「应该」「预计」填补。

## 决策摘要（一页纸）

1. **质量门五门本会话实跑全绿**：ds-bot 全量单测 1133 例（1132 过 / 1 跳 / 0 失败）、app 单测 99/99、lint 0 错误（15 警告）、`client.js --check`、DSH import 守卫——命令与输出见 §1.1。`npm test` 本身被操作系统拒绝（实跑），改跑 `package.json` 同一条 node 命令。
2. **C0.1 的代码面已完工但未提交**：`vendor/` 四薄替代 + `llm.js` 拆壳 + `llm-dsh.js` 注册壳 + 20 处 import 站点改指 + 守卫与 CI 步骤 + 测试词表映射 3/4，都在工作区（`git status --short` 实测 **22 个已修改 + 9 个未跟踪**，第 9 个未跟踪是本计划文档自身；本文创建前为 22 + 8）。距完成判据「闭包 0」差一个注册壳例外：本会话复跑闭包，117 个测试文件里 39 个 import 阶段可达 `@deepseek-ai/*`（1 个直连 + 38 个经 `index.js:8 → llm-dsh.js`）。smoke 未跑且本机不可跑。
3. **dsh-go 提炼：7 采纳 / 29 改造 / 5 否决**（§二；调研原书 45 条对标结论，合并 4 条重复后 41 条）。红线项全否决：其 10 个 DSH 构建期补丁（含最值得同情的 route-guard）与硬规则 1 冲突，phase C 前一律不可采纳。许可边界：整仓 AGPL-3.0（`sdk/` 与 `examples/` 为 MIT），与 Apache-2.0 不兼容——**AGPL 部分零复制**，只提炼思想、契约与格式，由我们原创实现；拟在 NOTICE 登记「设计参考，未使用其代码」。
4. **编排**（§三）：S1 C0.1 收尾提交（现在）→ S2 C0.2（5–8 天）→ S3 C0.3（7–10 天）→ S4 C0.4（8–12 天）+ S4b C0 账号评估（2–3 天，本计划建议；decouple:140 要求而基线漏收）；B1-4 配置迁移（输入已备，估时待设计后补）；并行轨道 P0/P1（1–2 周 + 2–3 周）、W-A 批次（7–12 天，W-A5 已随 borrowings 产出不计）、W-B 与 store 同批、ROADMAP §四 既有轨道、上游同步（每周 1–2 天）不受阻塞；进 C1 门槛 = C0.4 双跑差异=0 **且** C0 账号评估产出，B2 门槛 = C 完成 + client bundle 依赖有着落，D0 起依赖真机（用户侧）。
5. **因本计划新增的拍板/待办项 8 条**（§4.2 N-01…N-08）：attributionHeaders 身份漂移（**已修复**，见变更）、四处行为分歧的处理口径、hello 握手、proactivity「不是界面」边界、widget 渲染期降级、NOTICE 登记、守卫扫描范围扩到包根、dsh-go 调研出处归档。既有拍板项中 2 条状态改变：注册壳例外口径**已拍板接受**（§4.2 P-02，「脱离」改按「src/host 业务代码 0 + 守卫强制 + 注册壳单点」计）；§七.5 的三个小决策已由 C0.1 工作落地两个。

## 一、现状（2026-10-30 实测）

### 1.1 质量门五门（本会话实跑）

| 门 | 命令（本会话实跑） | 输出 | 结论 |
|---|---|---|---|
| ds-bot 全量单测 | `cd ds-bot && node --import ./test/harness-resolve.mjs --test "test/*.test.js"` | `tests 1133 / pass 1132 / fail 0 / skipped 1 / duration_ms 7225.9`，exit 0 | 过 |
| app 单测 | `cd app && node --test "test/*.test.mjs"` | `tests 99 / pass 99 / fail 0`，exit 0 | 过 |
| lint | `cd ds-bot && node scripts/lint.mjs` | `Found 15 warnings and 0 errors`，exit 0 | 过 |
| client.js 同步 | `cd ds-bot && node scripts/build-client.mjs --check` | exit 0 | 过 |
| DSH import 守卫 | `cd ds-bot && node scripts/check-dsh-imports.mjs` | `no DSH import outside the allowed files`，exit 0 | 过 |

说明：`npm test` 直接调用本会话实跑被操作系统拒绝（`npm error The operation was rejected by your operating system`），与 C0 基线 §附「npm 无法 spawn 时直接调 node」的口径一致（c0-execution-baseline.md:205-206），故上表跑的是 `ds-bot/package.json:44` 里 `test` 脚本的同一条命令；严格说 `npm test` 本身本次未通过，通过的是它包裹的那条命令。基线上 1133/1132/1 与 2026-10-28 复跑记录一致（c0-execution-baseline.md:208），app 99/99 与决策日志 2026-10-26 记录一致（ROADMAP.md:152）。CI 工作流未执行（见 §1.4）。

### 1.2 未提交的 C0.1 工作：已完工的代码面与未闭环的判据

**工作区状态**（`git status --short`，本会话实跑）：**22 个已修改 + 9 个未跟踪**（第 9 个未跟踪是本计划文档 `docs/plans/2026-10-30-dsh-go-borrowings-and-orchestration.md` 自身；本文创建前为 22 + 8）。未跟踪项：`docs/dev/2026-10-27-ab1-closeout.md`、`docs/dev/2026-10-27-c0-execution-baseline.md`、`docs/plans/2026-10-26-proactivity.md`、`docs/plans/2026-10-27-personal-agent-borrowings.md`、本计划文档、`ds-bot/scripts/check-dsh-imports.mjs`、`ds-bot/src/host/llm-dsh.js`、`ds-bot/src/host/vendor/`、`ds-bot/test/session-reference.js`。ab1-closeout.md:6 的提交提醒本身只列 **1 个已修改（`docs/plans/README.md` 的 2 行目录登记）+ 2 个未跟踪（proactivity、personal-agent-borrowings）**（本会话实读），早已过期；提交 C0.1 时须以本文的 22+9 清单显式挑选。

**与 C0.1 改动落点的对应**（基线 C0.1 的 4 个落点 + `index.js` 接线，测试词表映射单列一行，共 6 行台账；逐条本会话 grep/ls 实证）：

| C0.1 落点（c0-execution-baseline.md:92-95） | 状态 | 证据 |
|---|---|---|
| vendor 四文件 | 已完成 | `ls ds-bot/src/host/vendor/` → `messages.js`/`tools.js`/`web.js`/`llm-errors.js`；导出成员与 §2.3 表 13 符号一一对应（`grep -n "^export"`：createUserMessage/createAssistantMessage/createSystemMessage/createToolResultMessage/BlockAssembler、defineTool、WebError、HarnessError/LlmError/isHarnessError/assertUsableApiKey/attributionHeaders/fileHandleText） |
| 拆壳 | 已落地，命名与文档建议不同 | `llm.js:701` `export const botLlmAdapter = Base => class extends Base`、`:781` `BotLlmAdapter = botLlmAdapter(Object)`、`:787` `install(rt, Adapter = BotLlmAdapter)`；壳 `src/host/llm-dsh.js` 用 `botLlmAdapter(LlmAdapter)` 建壳并转发 install——文档建议名「llm-adapter-shell.js」带「如」字（:93），属建议 |
| import 改写 | 已完成 | 本会话 `grep -rn "vendor/"`（src/test/web-search.js）= **20 处 import 站点**（src 17 + test 2 + 包根 `web-search.js:11`）；§2.3 表 17 行 / 13 符号无残留（守卫生效即证） |
| index.js 接线 | 已完成 | `index.js:8` 由 `./src/host/llm.js` 改为 `./src/host/llm-dsh.js`（本会话 sed 实证）；MODULES 与 `module.install(rt)` 循环不变（c0-execution-baseline.md:15,106 的 37 个 MODULES 锚点） |
| CI 守卫 | 已完成 | `scripts/check-dsh-imports.mjs`（ALLOWED 4 项各带理由注释，:9-14：`src/host/llm-dsh.js` + `src/client/dsh-primitives.js`/`user-message.js` 两个 client bundle 文件 + `test/browser-plugin-output.test.js`）+ `test.yml:42` 在 lint 后加 `node scripts/check-dsh-imports.mjs` |
| 测试词表映射 | 3/4 | 已改：`at-menu.test.js:3`→新增的 `test/session-reference.js`、`mock-wire.test.js:8`→`vendor/messages.js`、`web-search.test.js:5`→`vendor/llm-errors.js`；未改：`browser-plugin-output.test.js:3-6` 仍直连 cordis/dsh-llm/dsh-system-prompt/dsh-tools（守卫 ALLOWED 注明「C0.3 moves it to the fake host」，check-dsh-imports.mjs:13） |

**闭包实测**（本会话复跑 C0 基线 §附的同款算法——读静态 import、相对路径解析为 `.js`/`index.js`、带环检测；脚本写在仓库外 `/tmp`）：**117 个测试文件，39 个 import 阶段可达 `@deepseek-ai/*`**。构成：`test/browser-plugin-output.test.js` 是 `test/` 下唯一有 `from '@deepseek-ai/…'` 静态 import 的文件（本会话 grep 实证，4 行）；其余 38 个经 `index.js:8 → src/host/llm-dsh.js`——`index.js` 是 `llm-dsh.js` 的唯一 importer（本会话 grep 实证），而 `llm-dsh.js` 是 `src/host/` 内唯一保留 DSH import 的文件（守卫生效即证；`src/client/` 下另有两个 allowlisted 的 DSH client-bundle import，见差距 7）。即 C0.1 完成判据①「闭包 0」与实测的差距，正是 §七.2 预留的注册壳例外，该口径文档标的是「请确认」、未经维护者拍板（c0-execution-baseline.md:97,181）。

**C0.1 剩余差距**（1–6 都不在「再写代码」里，但都要有归属；7 是 C0.1 台账外溢、B2 前必须有着落的剩余依赖）：

1. **注册壳例外口径待拍板**（上条）；不拍板则字面 0 不可达。
2. **`browser-plugin-output.test.js` 未迁**：文档划给 C0.3（:94），是「测试侧词表映射」落点项唯一未闭环的一条。
3. **`attributionHeaders` 身份漂移——本计划唯一实测到的非零语义回归**：`vendor/llm-errors.js:36` 硬编码 `version: '0.0.1'`，而 `llm.js:467` 与 `llm.js:775` 都是无参调用；DSH 侧默认身份是 `deepseek-harness/<包版本>`——本会话读 `dev/harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js:855-859` 与 `lib/types/attribution.js:14-20`（version 取自 package.json，实装 `0.2.1-rc.2`，`node -e` 读包版本实证）。即每条自有 provider 线序请求的 User-Agent 从真实版本变成 `0.0.1`。vendor:34-36 的注释说「DSH shell passes the running harness's own identity」，但没有任何调用方传入该参数。
4. **BlockAssembler 两处行为分歧**（调研材料实测复现）：①同一 index 上块类型变化且未 close——DSH 把后续 delta 并入已开的块，vendor 新建块并覆盖、丢失已累积文本；②`block-end` 之后同 index 再来 delta——DSH 丢弃，vendor 覆盖。ds-bot 自己的生产者不会触发（`llm.js:215-230` 的 blockTracker 恒先 block-start、换相位先 close；`parts.js:1216-1219`、`groups.js:994-997` 显式配对），但九个 `ctx.llm.stream` 调用点（本会话 `grep -rn "ctx\.llm\.stream" src/host` 实证 9 处：`btw.js:163`、`images.js:95` 与 `:189`、`memory.js:1255`、`parts.js:435/504/557`、`secrets.js:518`、`browser/session-model.js:175`；其中 `images.js:189` 与 `secrets.js:518` 是 `llm/stream` 中间件里的透传改造）吃的是 DSH 生产者 chunk 形状，本机无 key/网络无法验证。这正是 C0.1 风险栏「漏一个方法就是运行时错」的实例（:100）。
5. **另两处暂不可达的分歧**：`test/session-reference.js:17-28` 对坏 payload try/catch 吞掉、当普通文本留下，而 `@deepseek-ai/dsh-session-reference` 抛 `SessionReferenceError`（src 内零引用，只有 at-menu 测试用）；vendor 的 `LlmError` 把第三参原样 spread 进 `failure` 且不冻结（`vendor/llm-errors.js:12-18`），而 DSH 的 `failure` 是 `Object.freeze({message, code, ...status?, ...providerRetryAfterMs?, ...requestId?, ...offloadImages?})`——**同样保留额外字段，但逐个校验**（status 须 100–599 整数、providerRetryAfterMs 须正有限数、requestId 须非空字符串）并冻结（本会话实读 `dev/harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js` 的 LlmError 构造）。差异是「校验 + 冻结」而非「留不留字段」；src 内 6 处 `new LlmError(` 全两参（`llm.js:691/711/717/763/765`、`vendor/llm-errors.js:29`），暂不可达。`fileHandleText` 把空串路径当「无路径」而 DSH 当真实路径（`llm.js:518` 只传 undefined）。
6. **smoke 未跑，且本机不可跑**：C0.1 风险栏明确要求拆壳后过 `dev/smoke.mjs`（:100）。本会话实跑验证阻塞：`command -v setsid` 无结果；`../deepseek-harness`、仓库根 `deepseek-harness`、`ds-bot/deepseek-harness` 三处均不存在；`DSH_HARNESS` 未设置（与 ab1-closeout.md:55 一致）。注册壳的运行时行为目前只有单测覆盖，没有端到端证据。
7. **`src/client` 对 DSH client bundle 的依赖未列入 C0.1 台账**（C0.1 收口后仍存在的剩余依赖）：`src/client/dsh-primitives.js:3` 与 `src/client/user-message.js:2` 仍 `import … from '@deepseek-ai/dsh-client-ui-primitives'`（本会话实读），二者在守卫 ALLOWED 里（check-dsh-imports.mjs:10-11，注释即「compiled into client.js against the DSH client bundle」）；`src/client/speech.js:4` 的 `VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'` 是字符串引用，连静态扫描都不覆盖。`app/vite.config.js:8-14` 的 resolveId 插件只在 app 自有窗口构建时把 `./dsh-primitives.js` 换成 `app/ui/src/primitives.js`，插件形态的 `client.js` 构建（AGENTS.md 硬规则 4）仍要 DSH client bundle。B2「DSH 从安装包消失」（decouple:94-95）前这一项必须有着落（自有 primitives，或把该模块也做薄替代）——本计划把它写进 §3.7 的 B2 门槛。

### 1.3 待用户项（本会话未尝试其中任何一项）

| # | 事项 | 出处 | 状态 |
|---|---|---|---|
| 1 | 真机取证（桌面 app）：own UI 形态 DeepSeek OAuth 登录/登出端到端截图；补拍「设置」「Bot 详情」两屏；`DS_BOT_OWN_UI=0` 回滚形态回归 | ab1-closeout.md:65-69、:28；ROADMAP.md:151 | 待用户 |
| 2 | npm Trusted Publishing：在 npmjs.com 给 `miasaki-dsbot` 配 Trusted Publisher | ab1-closeout.md:71-75；ROADMAP.md:138 | 待用户（运营操作，仓库内无法代劳） |
| 3 | 阶段 A 真实自托管端点端到端（LM Studio 127.0.0.1:1234） | ab1-closeout.md:77-81 | 待用户；是验收缺口不是代码缺口（:81） |
| 4 | smoke 台架：deepseek-harness checkout + POSIX sh/setsid + pnpm | ab1-closeout.md:49-55；ROADMAP.md:151 | 本机不可跑（§1.2-6 实跑验证）；或等 C0.4 的 Windows 可执行入口（ab1-closeout.md:63） |
| 5 | Linux/macOS `dev/check.sh` 全套 | ab1-closeout.md:83-87 | 本机不可跑；本会话未尝试 |
| 6 | PR CI 查看 | ab1-closeout.md:89-98 | 未确认：代理 `127.0.0.1:1088` 拒绝连接；本会话按口径未重试 |

### 1.4 PR CI 未确认

`gh pr checks` 上次执行（2026-10-27）因本地代理拒绝连接而未取得任何 CI 状态数据（ab1-closeout.md:94-98）。本会话未重试（按该文档口径「仅一次，不重试」）。最近一条已落档的相关修复：`test.yml` result job 去掉对已删除 `app-package*` job 的引用（ROADMAP.md:151）。CI 真实状态以 GitHub 网页为准。

## 二、dsh-go 四面调研的提炼

### 2.0 调研口径与许可边界

- **对象**：只读浅克隆 `bb52f091`（2026-10-29，`--depth 1`），`dsh_client` 0.1.0 自称对 DSH 0.2.0-rc.2 / 0.2.1-rc.2 验证（其 README:3）；本仓库 `dev/harness` 钉 `0.2.1-rc.2`（本会话 `node -e` 读 `dev/harness/node_modules/@deepseek-ai/dsh/package.json` 与 `dsh-llm/package.json`，均 `0.2.1-rc.2`），版本对齐。前次针对 0.9.0 APK 的静态调研已入库（dsh-go-android-survey.md，提交 `8ca4686`），本文只补 Dart 客户端、协议、远程连接与 runtime/功能生态四面。
- **未执行**：本环境无 Dart（`which dart` 为空，本会话实跑），未运行其任何代码、构建、测试；其自带的测试与 live E2E 均标记为未跑。其「官方 DS Bot v0.2.3 应答夹具」（`dsbot_official_v023.json` 等）在它的只读副本内，**不在本仓库**（本会话 `ls ds-bot/test/fixtures/` 实证：只有 bing/duckduckgo 等既有夹具）——所以「我方 api/bot 契约被外部独立复现」这一结论的凭证是第三方材料，不是本仓库可复现的资产，引用时须如实标注。
- **许可边界**：整仓 AGPL-3.0（`sdk/` 与 `examples/` 为 MIT）。AGPL-3.0 与 Apache-2.0 不兼容（硬规则 3 只放行原创与许可兼容代码）——**AGPL 部分（app/、runtime/、packages/、services/、docs/ 全部源码与文案）零复制、零改写、零整段搬运**，只提炼思想、契约与格式，由我们原创实现；MIT 部分（`sdk/plugin-kit`）许可兼容，但按硬规则 3 仍以「不复制、只借鉴设计」为默认，若确有复用必要只能取该目录文件并在 NOTICE 登记「来源 + MIT + 版权人 DSH-TUI (ccch1mneyyy)」，且不带任何品牌素材；其名称、图标、吉祥物「保留所有权利」，不用。
- **两处点名**：(1) 其 `THIRD_PARTY_NOTICES.md:97-118` 的「DS Bot（Apache-2.0，已修改）」指上游 `Fei2411/DeepSeek-Bot`，**不是本仓库**（NOTICE:1-3 的版权行是「Fei2411 and the DS Bot contributors」与「Miasakiii and the miasaki-dsbot contributors」并列，本会话实读）——我们借鉴其 dsh-ui/公式那一层思想时，不应把它当作 dsh-go 原创引用；(2) 其手机操控代码派生自 Phase（「经作者许可使用」，非标准开源许可）、UI 结构派生自 PiPilot（MIT）——这类「非标准许可 + 派生」组合是又一重不碰其代码的理由。
- **出处归档缺口（待办 N-08）**：§二 41 条的行号级出处（`carrier.dart:34-70`、`README:134`、`THIRD_PARTY_NOTICES.md:97-118` 等）指向只读浅克隆 `bb52f091`，该克隆不在仓库内——按本文自定的三档证据口径，这批出处目前无法由本仓任何人复现。建议循前次安卓调研之例（dsh-go-android-survey.md 记 APK SHA-256 与静态口径，提交 `8ca4686`）把本次四面调研固化为 `docs/dev/` 文档（固定 commit、克隆与只读步骤、未执行声明）；本文只登记该待办，不代做。

以下三张表覆盖调研给出的全部 45 条对标结论；其中 4 条与他条重复（打码三类第二处、widget 三处合一后的余项、效果白名单第二处、一行上下文第二处——后者判 adapt 而首处判 adopt，合并时取 adopt 并附边界注记），合并后为 **41 条：7 采纳 / 29 改造 / 5 否决**，赋编号供 §三 引用。每条给出处与理由；**除注明外，许可结论均为「AGPL-3.0 零复制，只取思想/契约/格式」**。

### 2.1 采纳（adopt，7 条）

| # | 想法 | 出处 | 理由与落点 |
|---|---|---|---|
| A-01 | 把 api/bot 现有形状（「mobile 之前的形状」）冻结为对外契约；自有客户端策略仍走 app/ui React 壳 + Capacitor，不追 Flutter 重实现 | 调研 proofPoints（其只读副本夹具 `dsbot_official_v023.json`：官方 v0.2.3 的 hello→HTTP 200 `{ok:false,error:{code:'bot/not-found'}}`、feed 首块 `event: hello\ndata: {"revision":3}`）与 dsbotCoverage（其客户端调 29 端点、22 个与我们对得上） | 与本仓库事实逐字一致：`channel.js:518` 的 `bot/not-found`、`feed.js:45` 的 hello（本会话 sed 实证）；`channel.js` 现有 83 个 case（本会话 grep 实证）。D1 已拍板 Capacitor（decouple:131），其 Dart 客户端的价值在于「证明协议稳定、可被外部独立实现」，不在于照抄其栈。落点：decouple:176「不改 api/bot 协议」的外部论据 |
| A-02 | revision + modelsKey 双键短路原样保留，并写进自有客户端的状态同步设计 | 调研 proofPoints（其客户端发 `since`+`models`、未变把 team 置 null；对照 `channel.js:151`、`:36-37`） | `channel.js:151` 实测就是 `body.since === state.revision && (body.models === undefined || body.models === modelsKey())` → `{revision, unchanged:true, ...live()}`（本会话 sed 实证）。这是被外部读懂并按此编程的接口部分，阶段 D 客户端值得原样保留，不属于可精简项 |
| A-03 | 短时 access token + 每次轮换的 refresh + 重放旧 refresh 吊销整个 token 家族 + 到期前单飞刷新，作为 D2「短时可吊销 token」的机制骨架 | 调研 forOurD[1]（其 remote_account.dart:548-566、server_api.dart:186-217 对 token 长度/到期做强校验） | decouple:132 已把「短时可吊销 token」列为 D2 必答项，本条是现成答案；D3 验收明确要求「token 吊销生效」（decouple:134）。B1-1 出口目前只做本地回环自有 token、局域网绑定留到 D（decouple:82），轮换与吊销语义正是 D2 要新增的部分。机制/契约不是代码 |
| A-04 | 把威胁模型的残余风险显式写进 D2 文档：首接触不抗恶意 Server、指纹仅 48 位、同账号任一 client 被 Host 自动信任、账号失守=Host 失守、尚无 rekey | 调研 forOurD[9] 与 limits（其 README:134 作者自述） | adopt 的是「把不保证写清楚」这一纪律，不是它的结论数值。D2 要求「明确安全模型」（decouple:132）、D3 要真机验收（decouple:134）——没有写明残余风险，验收就没有判据。我们做隧道时必须同样标注：配对码首接触、短指纹、中继服务器可见流量长度与时间 |
| A-05 | proactivity 的「一行上下文」界面形态：输入框上方常驻一行「3/7 · 正在：跑测试」，点开原地展开整张清单，长期目标条可编辑、可暂停/恢复/清除，数据取自会话投影 | 调研 mappable[3]（其 roadmap.md:79,85-88） | 产品形态与信息架构，不是代码。我们的 live 数据模型已定稿（proactivity:189、:320），缺的是「一行呈现 + 原地展开 + 目标可暂停」的呈现约定。**边界冲突必须点明**：proactivity:303、:52 已定「live 不是界面、不做任务级进度视图」——所以只作为 P1 客户端面板/提案卡的形态候选，落地前需维护者拍板是否松动该边界（AGENTS.md：改已定设计需维护者）；且照形态不照语义（他们是只读投影，我们的是 Bot 自报 `state.live`） |
| A-06 | 把「设计借鉴也登记 NOTICE」写成明例，并注明两点：AGPL-3.0 登记≠许可兼容（只登记思想来源、不复制代码）；dsh-go 的「DS Bot」指上游，不是我们 | 调研 borrowable[13]（其文件头注明移植自上游 DS Bot 的来源/许可/修改点）与 licenseBoundary（THIRD_PARTY_NOTICES.md:97-118） | 本条本身就是许可纪律。NOTICE:85-103 已有「设计/实现受过哪些项目影响」的清单体例（如 NOTICE:98 的 obelisk AGPL-3.0 行，本会话 `git grep -in agpl -- NOTICE` 实证）；应写成明例并补两点注意。另注：NOTICE:98 该行描述的是「做什么」而非「复制了其代码」，是依赖声明还是代码引入需维护者确认（只读未改） |
| A-07 | 把许可红线落成可执行纪律：NOTICE 只登记确有引入的代码/素材并写清来源与许可；品牌素材（名称/图标/吉祥物）一律不用；MIT 部分复用须逐文件登记；「打码/隐私默认开启」类纪律不放开关 | 调研 licenseBoundary（dsh-go LICENSE 全文；ASSETS.md 行 1-13,25-27；THIRD_PARTY_NOTICES.md:44-54） | 本条是许可纪律的操作化，与 A-06 互补（A-06 管「设计借鉴怎么登记」，本条管「什么能入仓、什么永远不用」）。品牌素材一条已在 §2.0 边界承诺；「打码不是开关」已落 T-15；MIT 逐文件登记的默认是不复制。落点：NOTICE 与 AGENTS.md 硬规则 3 的执行细则、dsh-go-android-survey.md §七 |

### 2.2 改造（adapt，29 条，按落点分组）

**C0 契约与测试（T-01…T-06）**

| # | 想法 | 出处 | 改造点 |
|---|---|---|---|
| T-01 | 传输/协议分层：一元调用与物理链路分离，会话管理（ready 握手、generation、退避、流重开、挂起项按 eventId 重投）与载体无关 | 调研 borrowable[0]/[1]（carrier.dart:34-70：`DshCarrier` 只需 call/openLink/close；mux.dart:56-83 等） | 落进 C0.2 的 connection 路由面与 feed 契约：我们的 feed 断了只能靠 revision 重读（feed.js:20-21），api/bot 无 generation/游标概念——这是 D1 客户端与端云场景会撞上的契约洞。不需要其 uplink/隧道载体，只要「传输可换、协议不变」的接缝 |
| T-02 | 容错 JSON 读取（asMap/asString 一律返 null 不抛）+ 错误三分类（Host 决策 vs 管子问题）写进客户端解析与错误映射规范 | 调研 borrowable[3]/[4]（json.dart:1-57 注释理由；errors.dart:1-7,19-46） | 我们 host 侧加端点/加字段时已隐性依赖这个不对称性（我们多发的 `account` 事件落进其客户端「不认识的跳过、不报错」分支）。写成明文规范而不是各自即兴处理：客户端解析容错 + 错误只回答「是 Host 的决策还是传输问题」，落 D1 与 C0 事件契约文档 |
| T-03 | SSE 解析纪律（忽略注释行、多行 data 用 \n 连接、缺 event 默认 message、空行才成事件）+ 50s 静默判死 + 500ms→10s 退避表 | 调研 borrowable[6] 与 apiSurface（dsbot_api.dart:256-283、104-161、1272-1349；host 20s keepalive 对 50s 判死；对照 feed.js:16） | feed.js:16 实测 `KEEPALIVE_MS = 20_000`、:131 发 `: keepalive`，与「50s 判死」配对可行已被第三方作为设计声明（如实说明：其 live E2E 未跑，这是读到的声明而非跑过的结果）。D2 要补的是「静默判死 + 退避表 + 回前台按旧 revision 补拉」的明文数值，不重写 feed.js |
| T-04 | 把「POST /api/bot 或 feed 返回 404」当作能力失败（插件没装/过旧）而非瞬时掉线：停自动重试、拆状态、可用性改 outdated 交用户点重试 | 调研 borrowable[8]（bots_state.dart:333-341；dsbot_api.dart:90-94 对插件缺失 404 的判法） | 「没装」和「网络抖」在客户端必须分开——前者重试一万次也不会好，还会掩盖真实故障。写成 D2 客户端状态机的一格（available / reconnecting / outdated / unauthorized），与 401/403→需重登同一张表 |
| T-05 | dev/ 下补「对着真实 Host 打协议」的探针：JSONL tracer 记每一帧，一个命令覆盖 list-only、prompt、审批、cancel-after、断线重连验证、--record | 调研 borrowable[12]（connection.dart:82-103；probe.dart:19-44,146-307） | 判为 adapt 不 adopt：应挂在 C0.4 双跑载体落地之后，否则没有可比对基线。工具我们原创（Node 侧）；遵守硬规则 2（用 dev/mock-llm.mjs，不写不打印 key/token/cookie）与硬规则 5（只打 `.dsh-test-<name>/` 台架） |
| T-06 | 给自有客户端加最小版本握手（hello：api/apiMin/apiMax/capabilities/boot/seq；规则是「只加东西不升 api，写进 capabilities；会让旧客户端读错的才升 api」），解决 app/手机/NAS 三端版本不一致；**但不合入上游 mobile API 的 29 端点** | 调研 borrowable[2]（dsbot_api.dart:23-26、288-337；契约见其 upstream/feat/mobile-api 的 docs/plans/2026-10-24-mobile-api.md）+ dsbotCoverage ② | mobile API 只在其 `remotes/upstream/feat/mobile-api`：本会话从仓库根实跑 `git log --all --oneline -- ds-bot/src/host/mobile.js` 返回 2 个提交（`6f3e1b3`「Serve the client API as Remote methods for relays」、`8709158`「Add a client API for windows that draw the team themselves」，均只在 `remotes/upstream/feat/mobile-api` 可达）、`git merge-base --is-ancestor 6f3e1b3 HEAD` 退出码 1、`git cat-file -e HEAD:ds-bot/src/host/mobile.js` 报 does not exist、工作树无该文件——从未合入 HEAD，保持不合入。只取握手与能力声明的最小形状，作为**新增端点/新增 feed 事件**引入，不动现有 29 端点形状（decouple:176） |

**阶段 D 客户端与安全（T-07…T-14）**

| # | 想法 | 出处 | 改造点 |
|---|---|---|---|
| T-07 | D2 配对用 TOFU 指纹钉住：首次连接在用户明确批准后钉住对端身份密钥，密钥变更在开任何 socket 之前就以身份不符中止（fail-closed） | 调研 forOurD[0]（remote_account.dart:712-714,910-923；noise_test.dart:101-117；48 位指纹） | 其 Noise/X25519 状态机在 AGPL 内零复制；我们只用 Node crypto 原创实现，只学「信任锚定 + 变更即 fail-closed + 先于建链」这一结构。正好补上「配对码之后如何防降级/防中间人更换」这一环；48 位指纹的碰撞面要一并评估 |
| T-08 | 密钥握手 prologue 把协议版本、连接 id、双端 device id 一起混入派生材料，防跨连接重放与两端混淆 | 调研 forOurD[2]（noise_ik.dart:481-498；noise_test.dart:136-151） | 格式字符串不抄，只取「把连接标识与双端标识绑进密钥派生」这一廉价抗重放契约——成本近零、消掉一类跨连接重放。与 T-09 的每帧计数器叠加使用 |
| T-09 | terminal failure 粘住不自动重连：被替换（连接被接管）、吊销、身份不符、协议不匹配等终态停掉退避 loop，须用户显式 reconnect() | 调研 forOurD[6] 与 limits（tunnel_carrier.dart:327-331,396-405；reconnect_policy_test.dart:28-50；terminal 码清单 remote_account.dart:992-1002） | 我们 feed.js 侧只有 keepalive 与从 hello 重连（feed.js:20-21、:29），没有终态概念；一旦上了可吊销 token，「被吊销」必须表现为停手+提示用户，而不是无限退避把服务端日志刷爆。终态码清单按我们自己的 token/配对语义重列，不照抄其码值。落 D2 重连策略 + D3 验收「断线重连与 token 吊销生效」（decouple:134） |
| T-10 | 客户端先行 endpoint allow-list：本地先拦，未列者本地即返回 METHOD_NOT_ALLOWED，形成最小权限远程面 | 调研 forOurD[7]（tunnel_carrier.dart:21-122,233,424-430） | 主机侧已有一半：`channel.js:144` 的 READS 集合与 `bot/read-only` 模式。allow-list 是同一思想的客户端侧落地，D2 把可达端点显式列全即可；清单按现有 83 个 case（本会话 grep 实证）裁剪成 D3 需要的子集，不是新协议 |
| T-11 | 手机端读大 JSON 用「只读端点枚举 + 不可变请求快照过界 + 准入控制（同时 2 worker、8 排队，超了立即失败）+ 分阶段超时 + 体积与深度上限」的时间表 | 调研 borrowable[9]（background_session_read.dart:25-39,92-106,155-200） | 数值（2/8/超时档）按 Capacitor WebView 实测重定，不照抄。依据：proactivity:94 说明 state.json 每次保存整份重写、只放有上限字段——窄屏/弱网下全量重读是真实风险，且 feed 补拉就是整页 revision 重读（feed.js:20-21）。D0 手机浏览器验证时应顺手量一次 |
| T-12 | 有界媒体 GET（不跟跳转连同源、字节上限、连接/头/体一个总 deadline、独立连接读完即强制关闭）+ 二进制结果走 multipart（metadata 放常规信封、字节处留 null，attachments 表指向裸字节字段） | 调研 borrowable[10]/[11]（connection.dart:337-405；binary_response.dart:1-17、carrier.dart:154-164） | multipart 是「已验证的线路格式」，可学其形状由我们原创实现。D2 thin client 要读 Bot 工作区文件，字节上限与总 deadline 是防弱网挂死的最小集；我们的 file-text 已保留 Host 的 `whole` 完备性标记（其客户端复现了这一点），缺的是明文上限。与 decouple:194 的防泄漏闸互补 |
| T-13 | 传输接缝思想：数据面可换（Relay/WebRTC/LAN/TURN 只留接缝），协议不变；多种传输实现本身否决 | 调研 limits[0] 与 design（transport.dart:10-14；其 README:13 仅 Relay 一种数据面） | 它自身也只实现了一种数据面却把传输做成接缝——正好证明「先定协议、传输后换」的次序。D2 设计时把「隧道」抽象成可替换的 transport 接口（与 T-01 同源），但不实现 WebRTC/TURN；多人/多端场景留给端云设计（borrowings T-08） |
| T-14 | 远程/移动下的能力降级写成一张显式清单（仅图片附件可用、App 内打不开网页版、插件管理仅限开关、不支持 DS Bot 与对话日志导出），作为 D3「thin client 已知限制」的写法 | 调研 limits[1-5]（README.md:178；docs/guide/zh/03-engine-hosts.md:81） | 只学文档形状。D3 已定「后台推送不做、桌面休眠不可用」写进 README 与已知限制（decouple:133），扩成一张降级表比一句散文更可检查；清单内容按我们自己的 api/bot 面重列（如浏览器面板依赖 Electron webview 租约，移动端天然不可用——decouple:119 已述该桥不是 CDP）。README 与 README.zh.md 两份一起改（AGENTS.md 风格节） |

**ds-bot 自有功能与主动性（T-15…T-21、T-29）**

| # | 想法 | 出处 | 改造点 |
|---|---|---|---|
| T-15 | 打码规则从「列举式替换」扩成三类：键名（名字像密钥的赋值）、值形态（sk-/ghp_/JWT/私钥块/URL 内密码）、路径（家目录→~、私有目录→…、图片引用→〔alt〕），且打码不是开关、始终生效 | 调研 mappable[17]（share-codes.md §8.3 行 208-215；share-redesign.md §5 行 181-184） | 与「分享/导出」功能解耦——导出、诊断外带、回放、移动端转发一段会话都应走同一套三类打码；不必等 share-links 那样的托管服务。与 W-A2 的相邻处：audit 落盘前也过同类脱敏（borrowings:347-350 已写「不含密钥、复用 secrets.js 的脱敏」）——三类规则同时服务三个面，但实现各归其位，不合并范围。落地时先补识别规则与测试夹具 |
| T-16 | widget 视图预算按承载位置分档显式枚举（toolCard 8 KiB/40 节点/6 层、panel 32 KiB/120 节点/8 层、strip 三档），超限一律截断并在被截组件下方标一行小字 | 调研 mappable[0]（native-plugins-views.md §5 行 137-159） | 我们目前是单一 8 KiB/64 节点/8 层（widget-views.md:36，本会话读该文档附近实证其上限表）。分档意味着多一份上限表与多套错误文案——其做法是把上限总表做成机器可读、随 contributions 下发；若我们只经 show_view 一个入口，可只分「工具卡/待答卡/纯展示」三档并共用一张表。属可做可不做，建议排在 widget 视图稳定之后 |
| T-17 | 渲染期降级作为原子拒绝之后的第二道闸：根节点坏→整块降级一行「插件界面有误」；子节点 type 不认识或缺必填→该子节点换灰色占位、其余照画；绑定取不到→文字显「—」、数组显「暂无数据」、按钮组不画，且都不算错误 | 调研 mappable[1]（native-plugins-views.md §3 行 99、§6 行 185-197） | 我们的原子拒绝（widget-views.md:35，防坏蓝图进交接包、给模型带路径的可修复错误）理由仍成立，所以要的是「双闸」不是替换：登记期原子拒绝 + 渲染期降级，兜住「新蓝图被旧客户端读」这一类版本错配（与 T-06 同一问题域）。降级文案要英文（AGENTS.md 风格节）且与现有带路径错误共用问题收集结构。**需维护者拍板** |
| T-18 | 把「问题列表 + 路径」做成统一诊断面：插件详情页只安静显示一行「原生界面 · N 项有误」、不弹窗；解析结果按 view/data 的对象身份缓存（数据变了必须传新 Map，否则画旧数据） | 调研 mappable[2]（native-plugins-views.md §9 行 338-339、§6 行 208） | 我们已有 viewCardText 摘要与带路径错误（widget-views.md:35），缺「安静一行 + 可点开看全部 + 对象身份缓存」三件；缓存那条尤其实际——视图卡重渲染频繁（feed 事件触发 state 重读），按身份缓存能省重复解析。行数与措辞按我们诊断面板现有风格统一 |
| T-19 | 效果白名单 + 3 秒窗口 + 无点按不触发 + 永不开放授权类能力（批准工具调用、改权限模式、装卸插件、切主机、读设置或凭据）+ 连续 5 次违规降级，作为阶段 C 第三方扩展面的设计参考 | 调研 mappable[15]（native-plugins-protocol.md §5-§6 行 467-483、§4.4 行 408-415） | 与我们 browser-plugins「读放行、写审批、付款/删除/登录交人」同构；C3 给 MCP/连接器做最小权限面时可直接借用「白名单+降级」结构。3 秒窗口对我们意义有限（无跨进程 UI 回调），只取白名单与降级两件 |
| T-20 | 插话/打断/排队对照其 SendMode 四态（now/steer/queue/interrupt）补两件我们缺的：显式的「停下来先处理这条」中止语义，以及排队中的消息可改成插话或撤回 | 调研 features[2]（chat_state.dart:16-40,1082,1418-1430；chat_list.dart:708-725） | 现状锚点：`delivery.js:90-100` 已按 steer 分派 agent.steer/agent.followup；`groups.js:410-425` 的 waitingLines 已报告排队/插话；`turns.js:473-477` 已处理中途 relay 的 steer；btw.md:8 已写明排队与插队的代价。缺口是 interrupt 语义与排队项的用户侧改派/撤回没有明文契约，D1 的 composer 需要它。不动 decouple:119 要求保留的两级队列本身 |
| T-21 | 整轮折叠规则：正常结束的一轮把思考/工具调用/中间消息收成一行「已完成 · N 次工具调用」，回答留在外面；停止/出错的轮不收；带原生卡片的调用「工具行收进去、卡片留在外面」；插话把一轮切成几片、各片各自收尾 | 调研 features[3]（chat_rows.dart:180-208 注释与 foldTurns、:285-330 fold()） | 我们的 show_view 卡在长回合里的位置没有明文规则，而「卡片留在折叠行外面」正好保护 widget 视图的可见性——否则一次多工具调用的回合会把用户的待答卡一起折掉。规则写成三行清单（收什么/留什么/切片怎么办），按我们 steps 展示（turns.js showSteps）重画，不引入其行组件结构 |
| T-29 | notify 节流与免打扰粒度：每来源每分钟 1 条、用户可逐项关闭、后台走系统通知/前台走玻璃横幅、锁屏脱敏、别处处理后自动撤回 | 调研 mappable[4]（native-plugins.md §3.3 行 248；roadmap.md:13） | 落 proactivity §事件与主动回合（:99-147）与提案卡（:149 起）+ 度量（:242「用户关掉主动的 Bot 数」）。硬规则核查：原创实现；P0/P1 不动 app/（并行轨道约束）——系统通知属 app 壳，P0 阶段只做进程内呈现与关闭开关，通知留待 D/B1 之后（W-A1）。适配点：锁屏脱敏一条直接复用 T-15 的打码三类，不另做；节流数值（1 条/分钟）按我们的主动回合频率重定 |

**B2 打包/发布/运维（T-22…T-28）**

| # | 想法 | 出处 | 改造点 |
|---|---|---|---|
| T-22 | 把 dsh-go 的 runtime manifest 当作「自有引擎打包单一事实源」的 checklist 模板：版本矩阵、每个产物的哈希/来源/补丁、启动 argv 模板与占位符语义、token 行、认证交换、健康检查、优雅/兜底停止、关键文件路径 | 调研材料所引 rtbuild.py:1302-1385（launch_template 八块）、:1388-1445（manifest schema 1）；前次调研 dsh-go-android-survey.md:84-86 | 只取「字段与契约结构」这一层思想，JSON 键名与取值由我们自己定义；其 manifest 服务 proot rootfs 场景，我们按桌面安装器裁剪字段，不做全盘照搬。其 `inputsSha256_12` 把补丁计入输入，我们无补丁，等价物是「自有引擎版本 + lockfile 哈希 + 构建脚本哈希」。落 B2 安装器与发布物核对、D0/D1 若出安卓包 |
| T-23 | 四条可迁移的运维契约：就绪判定两段（日志就绪行不算数，要真连上端口）、健康检查契约（TCP 通 + 无凭据 401 / 带凭据 200）、优雅停止阶梯（先让被监督方自己 dispose，超时才升级信号）、进程归属按身份（rootfs+uid / cwd / argv）而非全局名匹配，且「读不到」记 uncertain 与「不存在」分开记账 | 调研材料所引 DshProcess.kt:250-272、:317-337、:377-405；rtbuild.py:1368-1378；RuntimeProcessOwnership.kt:94-109 | 落 `app/src/host-process.mjs:65-74`（现 stop() = 10s 后 kill、再 5s SIGKILL，:37 spawn 本机 node）与 D2 认证面、C0 崩溃恢复（c0-execution-baseline.md:182）。「归属按身份、不能全局匹配 dsh web」的教训直接服务硬规则 5——误匹配用户自己的 DSH 进程即是碰用户数据。proot 信号细节是 Android/tracer 特有，桌面不适用，只取阶梯与两段就绪；90s/120s 等阈值按桌面场景自定 |
| T-24 | 更新链四条：元数据源有序且「上次成功的排最前」；SHA-256 必须、签名才是最后一道防线（威胁模型=镜像同时篡改清单与包）；节流（成功 24h / 失败 4h / 时钟回拨视为到期）+ 磁盘预检 + 断点续传；发布流水线「上传→下载回来核对→全部一致才上线」+「同版本换包即拒绝」 | 调研材料所引 docs/release.md:153-280、:234-270、:365-427 | 落 B2 发布链验收（decouple:95）与 `app/src/updates.mjs`（:27 RELEASES_URL 指 fork GitHub API、:26 4h 检查、:29 parseVersion semver）。**必须如实记录的差异**：它「签名是最后一道防线」，而我们已拍板 Windows 不签名、macOS ad-hoc（decouple:142）——我们只能到「SHA-256 必须」这一层，且要把「不签名 = 清单与包可被同时篡改」写进 README/发布说明，不能假装有签名兜底；其「同版本换包即拒绝、修包升版本名」可直接作为发布纪律 |
| T-25 | plugin-kit 三件套参照：JSON Schema 作为协议/视图的机器可读真源（类型从 schema 生成）、校验器与宿主同源（清单校验复用桥接解析器、视图校验是 App 解析器的逐行孪生、退出码 0-3 分档）、createTestHost 状态回读（contributions 行含 ok/degraded/unsupported/needs-app/invalid） | 调研材料所引 sdk/plugin-kit/README.md:5-16,18-56,60-73；docs/design/native-plugins-protocol.md §7 行 495-517（limits 机器可读） | `sdk/plugin-kit` 为 MIT（© 2026 DSH-TUI (ccch1mneyyy)）与 Apache-2.0 兼容，但硬规则 3 默认原创——若确要复用只能取该目录、登记 NOTICE 且不带品牌素材；本次不建议复用，只取思想。其 native 协议本体（Flutter AOT 不能加载外来 Dart 故「App 不执行任何外来代码」）是它的硬约束，我们 Capacitor 路线不适用。可落地点：MCP/连接器的「能力健康态分级」诊断面；「上限总表机器可读、宿主与校验同取一处」对照 widget-views.md:36 的单一上限清单。落 C3（decouple:119,204） |
| T-26 | 保守的崩溃分类 + 安全模式 + LKG：只有引擎自身 fatal 标记才算插件/配置问题，无标记退出归 KILLED 永不计入；连续两次计入失败→安全模式；自动重启只对「跑了 60s 以上被外部杀」生效、10 分钟最多 3 次；离开安全模式有两分钟试用期 | 调研材料所引 CrashClassifier.kt:76-101,112,118-138；SafeMode.kt:97-120；SafePolicy.kt:35-39,75-80 | 正好承接「上游已知软肋：群轮次状态纯内存崩溃丢本轮、下游等待无超时」（decouple:194）——在自有循环里做崩溃分类与监督重启不碰 DSH。其具体数值（就绪后 120s、60s、3 次/10 分钟、两分钟）是 Android 场景参数，我们按桌面场景自定并写进自己的设计，不当需求照抄。注意：C0 若要含这块，需按 open decision（c0-execution-baseline.md:182）另立切片或短文，否则按现状它不在任何 C0 切片里 |
| T-27 | 版本号用「构建分钟」编码（versionCode =（年-2026）×10^8 + MMDDhhmm，时钟固定 UTC+8）：开发与正式共用一条单调序列、人眼可读、可反查、安装器不会当降级清数据 | 调研材料所引 docs/release.md:43-66 + tooling/build_number.py（调研者用自写只读代码复算三例吻合；该脚本本身未运行） | 算术公式与理由陈述，无版权障碍。适用性判断：我们已拍板 electron-updater + semver 且「不能降级、保留 N-1 回滚兼容」（decouple:142），桌面侧无需改版本策略；只有将来做 Android 安装包（versionCode 是 Android 必需字段、厂商 ROM 按包名+versionCode 决定是否刷新缓存图标）时才启用——**条件采纳，不是现在改** |
| T-28 | 两条运维卫生：启动 argv 里的 KEY=value 按 key 名脱敏（key/token/secret/password）、崩溃摘要里 token 替换成 `token=•••`、环境值只用于判定归属从不进日志；通知按语义分层「可停止性」——安装/进度类只有进度没有「停止」，运行类带「停止」 | 调研材料所引 DshProcess.kt:339-353,407-412；CrashClassifier.kt:112；DshService.kt:73-86,232-242 | 落 W-A2（borrowings:347-350「不含密钥、复用 secrets.js 的脱敏」）与 W-A1（:339-343）。硬规则 2 是同一红线的仓库内版本；它的价值是给出「按 key 名脱敏 argv」「日志里 token=•••」两个可检查的具体形态，以及「通知按语义分层可停止性」这个我们 W-A1 没想到的维度（避免用户点「停止」得到语义不符的行为）。它「/proc 只读本 uid」是 Android 多 App 场景；桌面单用户下我们仍遵守硬规则 5，归属判定只用于我们自己 spawn 的进程 |

### 2.3 否决（reject，5 条，含红线项）

| # | 想法 | 出处 | 否决理由 |
|---|---|---|---|
| R-01 | 用 10 个构建期 `.diff` 修改打进 rootfs 的 DSH 副本（route-guard 是最值得同情的一个：本机引擎 127.0.0.1:3080 的回环在 Android 对所有联网 App 共享，而 `dsh-host-webserver` 只做路由分发不鉴权） | 调研材料所引 runtime/patches/ 十个 diff + rtbuild.py:337-383；plugin-seams.md:296-299,306-320；前次调研 dsh-go-android-survey.md:58-62 已判违反硬规则 1 | **红线项**。硬规则 1：phase C 前绝不 patch DSH、绝不改 DSH 安装内文件——这 10 个补丁全部是对引擎本体的源码修改，「只打自己打包的副本」不改变性质；phase C 后我们换自有运行时，更不需要它的补丁。补丁文本属其 AGPL 部分，复制/改写入仓同时违反硬规则 3。它堵的洞是真的（其抽样 13/15 插件有自定义路由，其中 `/dsh-pet-*/chat` 能直接花用户模型额度），其设计文档给的正解是上游默认套 `requestRejection` 或给 `register` 加 `auth` 选项——我们的合规替代：(a) 推动上游；(b) C 前在 `dsh web` 前放我们自己的网关做 Host/Origin + cookie/credential 检查（D2 的 token 认证天然覆盖，decouple:132）；(c) phase C 自有运行时解决。其 bridge 半侧的 register 包装是合规的那一半，但作者自述依赖加载顺序、只是 PoC，不列为计划项 |
| R-02 | 端到端加密托管链接 + 回放查看器整体（现在） | 调研 features[11]/[12]/[13]（share-links.md §1/§3/§4；share-codes.md §8.1、§8.5） | 不是评估为无价值，是评估为现在不该占 D 的名额：托管链接需要对象存储与删除令牌服务，与「无自建后端、单人维护」冲突，且与「数据留在用户自己电脑」的 vision 取舍需另拍板（borrowings 决策单 ⑤ 同类问题）；D3 范围明确限定为聊天读写/@ 派活/审批/Bot 管理、后台推送不做（decouple:133）。其分享码/加密格式（DSG1+12 字节 IV 等）一律不抄，只作为「以后要做时的参照」记录 |
| R-03 | 桌宠（状态指示器玩法）、语音租约（audio/voice/micro/overlay）、网页岛座位规划 | 调研 features[6]/[10]/[16]（pets.md §0/§1.2；native-plugins-protocol.md §11 行 548-623；plugin-seams.md §0/§2/§4） | 与「thin client 连桌面后端、后台推送不做」的定位冲突；单人维护与 bus factor 1 的约束（decouple:194 附近自述）。如实记录：其「受保护页面清单」（安装/权限/安全中心只读不操作，使 agent 无法给自己授权）这一具体思想有防护价值，若将来做浏览器写操作可再评估，现在不进计划 |
| R-04 | 无障碍读屏/点按的手机操控：三档确认 + 受保护页面清单 + 银行卡号与身份证号读屏掩码 | 调研材料所引 docs/guide/en/04-phone-control.md 行 20-23,52-63,76-94；ProtectedPages.kt:1-60；ScreenMask.kt | 范围核查：D3 已定 thin client（手机连桌面后端、同可信网络、桌面休眠不可用），不含「手机操控其它 App」；我们的浏览器坐标操作是 borrowings W-A4，作用于自建浏览器桥，与系统读屏不同类。许可核查：其手机操控代码派生自 Phase（「经作者许可使用」、非标准开源许可）+ Kotlin 属 AGPL——双重不可复制；其「确认分级 / 受保护清单 / 掩码」思想我们 browser-plugins 已有同构实现（读放行、写审批、付款/删除/登录交人），无需外取 |
| R-05 | proot 专属手段（boot-cache 冷启动缓存、link2symlink/L2S 假硬链接迁移、direct 模式的 dlopen 模块身份校验、env -i + 固定 PATH、resolv.conf 每次启动重写）迁移到我们这里 | 调研材料所引 boot-cache.mjs:19,118-190；DirectLaunch.kt:104-110；DshProcess.kt:200-222；GuestSetup.kt:18,93-160；modules.mjs:19-32,55-78,115-125 | 范围核查：我们的桌面 app 不经 proot 启 DSH（`app/src/host.mjs:9` 用文档化入口 `@deepseek-ai/dsh/profile-boot` 的 runProfile，`app/src/host-process.mjs:37` spawn 本机 node 跑 Host）；D 阶段拍板 Capacitor thin client 连桌面后端，不做「手机本地跑引擎」——全部无落点，搬进来是为不存在的场景加复杂度。许可与硬规则：其代码属 AGPL 不得入仓（硬规则 3），即使将来自建 Android 引擎也须原创实现（硬规则 1/3）。保留价值仅在于：若路线有变，这份「陷阱清单」是第一手复查材料，记入调研文档即可 |

## 三、剩余任务编排

### 3.0 总顺序与依赖

主线：**S1（C0.1 收尾提交）→ S2（C0.2）→ S3（C0.3）→ S4（C0.4）**，与 C0 执行基线的顺序一致（c0-execution-baseline.md:85；C0.1 与 C0.2 可部分并行，但 S1 只是提交+台账，不占 C0.2 的关键路径）；**S4b（C0 账号评估）**是 decouple:140 要求而基线漏收的 C0 设计产物，可与其他片并行（§3.4b）。并行不受阻塞：S5（B1-4，输入已备）、S6（P0/P1）、S7（W-A 批次）、S8（W-B 与 store 同批）、S9（ROADMAP §四 既有轨道）、S10（上游同步，贯穿）。阶段门槛见 §3.7。对标结论对编排的逐条修改，在各片「对标修改」行注明来自 §二 的哪一号。

| 片 | 内容 | 依赖 | 估时 | 出处 |
|---|---|---|---|---|
| S1 | C0.1 收尾提交 + 遗留台账 | 无 | 0.5–1 天（本计划建议） | c0-execution-baseline.md:87-100 |
| S2 | C0.2 `rt.host` 契约层 | C0.1 | 5–8 天 | :102-117 |
| S3 | C0.3 fake-host 与分层迁移 | C0.1、C0.2 | 7–10 天 | :119-130 |
| S4 | C0.4 双跑 golden master | C0.2、C0.1 | 8–12 天 | :132-144 |
| S4b | C0 账号评估（自研 OAuth/token 服务评估 + 保底路径） | B1-2/B1-3（已落地） | 2–3 天（本计划建议） | decouple:140 |
| S5 | B1-4 配置迁移 | B1-3（已落地） | 未估（设计后补） | ROADMAP.md:83-85、:151 |
| S6 | proactivity P0 + P1 | 拍板 + C0.1 收口 | P0 1–2 周 + P1 2–3 周 | proactivity.md:222-223 |
| S7 | borrowings 批次 A（W-A1..W-A4；W-A5 已随 borrowings 产出，不重排） | 无 | 合计 7–12 天 | borrowings:337-371 |
| S8 | W-B 设计类 + store 同批 | S6 同批 | W-B5 设计 2 天，余见 borrowings | c0-execution-baseline.md:173-175 |
| S9 | UI/外观、fleet CLI、发布链 | 无（发布链为 B1 前置） | 见 ROADMAP §四 | ROADMAP.md:81-92 |
| S10 | 上游同步 | 贯穿 | 每周 1–2 天（计入资源预算） | ROADMAP.md:100-101 |

C0 四片（S1–S4）按本表分项合计 **20.5–31 人日**（含 S1 可选行为锁定则 21–32）；基线的 23–35 人日含 C0.1=3–5 天的旧口径（c0-execution-baseline.md:85,98），本计划因 C0.1 代码面已完工把 S1 压到 0.5–1 天而下调——这是与基线的口径差（已完工的工作不再计估时），不是基线的错误。关键路径 6–8 周的规划口径不变（decouple:113；该口径含评审、smoke 回归与并行余量，本就宽于人日之和）。S4b 账号评估（decouple:140 要求）单列 2–3 天（本计划建议），可与其他片并行。

### 3.1 S1：C0.1 收尾提交（现在）

- **内容**：把工作区的 C0.1 产物显式挑选提交（22 个修改 + 8 个未跟踪逐项对应 §1.2 表，勿 `git add -A`——5 份未跟踪规划文档〔ab1-closeout、c0-execution-baseline、proactivity、personal-agent-borrowings、本文〕是否随片提交需维护者定）；建议随提交补 3–4 条行为锁定测试（§1.2 差距 3/4/5）；把两项遗留（注册壳口径、browser-plugin-output 迁移）登记进 C0.3/C0.2 的开工清单；确认 CI 守卫生效后的扫描范围缺口并安排补丁（见「对标修改」）。
- **开工判据**：无——代码面已完成，五门本会话实跑全绿（§1.1）。
- **完成判据**：①提交落库、`git status` 除规划文档外干净；②提交树上复跑守卫 / lint / `--check` / 全量单测全绿（同 §1.1 命令）；③闭包复跑维持 39 且构成不变（1 直连 + 38 注册壳）——**P-02 已于 2026-10-30 拍板接受注册壳例外（出路 a）**：「脱离」口径为「`src/host` 业务代码 0 + 守卫强制 + 注册壳单点例外」，本判据即该口径下的达成态；出路 b（fake-host 供给 `LlmAdapter` 基类）留 C0.3，S3 开工判据「C0.1 完成（闭包清零）」按同一口径改写；④smoke 在可跑环境补跑并记录输出——**未跑 smoke 不得将 C0.1 标记为完成**：本机实跑验证不可跑（§1.2-6），且替代路径「C0.4 的 Windows 可执行入口」是 8–12 人日后才交付的产物（§3.4），不能充当本次判据；合并前需维护者明确接受「无端到端证据」或安排可跑环境补跑（AGENTS.md 对 `index.js`/`src/host` 改动要求跑 smoke，ROADMAP.md:106）；⑤两项遗留写入 C0.3 开工清单。
- **依赖**：无。
- **估时**：0.5–1 天（本计划建议；C0 基线给 C0.1 整体 3–5 天，:98，代码面已占主要部分）+ 可选行为锁定 0.5–1 天（本计划建议，无文档估时依据）。
- **风险**：①提交面失控（把 5 份未跟踪规划文档一起提交，含本文）；②smoke 未跑就提交，与 C0.1 风险栏要求（:100）相悖——只能记录并在 POSIX 环境补，或由维护者明确接受；③四处行为分歧若不补锁定，会被后续 C0.2/C0.3 当作既定语义固化。
- **对标修改**：T-05/T-06 的新代码（探针、hello）都必须过 CI 守卫——而守卫现在只扫 `src/` 与 `test/`（check-dsh-imports.mjs:31 实测），不扫包根的 `web-search.js`/`index.js`/`scripts/`；`web-search.js` 正是 C0.1 的 carrier 之一（:11 走 vendor/web.js，本会话 grep 实证），现在干净，将来谁把 DSH import 加回去守卫不会报。**建议随本片或 S2 把扫描范围扩到包根**（本计划建议，无文档依据；对应拍板项 N-07）。

### 3.2 S2：C0.2 `rt.host` 契约层

- **内容**：按 c0-execution-baseline.md:106-112 的五面（服务面 inject 8 + ctx.get 21 名/45 次 + ctx.inject 动态 4 处；事件面与中间件顺序 11 核心 + 5 可选 + next() 链语义 + prepend 6 处；Agent/Session 对象面；effect/dispose lifecycle 31 处含 async disposer 与 LIFO；隐藏运行时态 `ctx.fiber`）+ 工具注册面（31 处）+ connection 路由面（2 条）；新增 `src/host/rt/`（host.js 接口 + dsh.js 实现）与 `test/fake-host.js`；挂载点是 `index.js:82` 的 `createRuntime`/`rt` 对象与 37 个 MODULES 的 `install(rt)`。
- **开工判据**：C0 基线评审通过（:113，即 §七 各条拍板——尤其注册壳例外口径 N/P-02）；C0.1 的 vendor 面定型（并行过半即可）。
- **完成判据**：五面接口成文（JSDoc/类型）；`rt/dsh.js` 过 `dev/contract/` 行为锁定测试；fake-host 按接口可跑通 L2 抽样（与 C0.3 合并验收）。
- **依赖**：C0.1。
- **估时**：5–8 天（:115）。
- **风险**：cordis 边角语义（`fiber.await` 超时、plugin 重挂、prepend 与 next 的组合序）只能在锁定测试里逐个钉住，漏钉的到 C 才暴露；范围蔓延——接口只收 src/host 实际用到的成员，不预先设计 DSH 全表面。
- **对标修改**：**T-01**（传输/协议分层）落进 connection 路由面与 feed 的契约定义——carrier/mux 的「一元调用与物理链路分离、generation/退避/流重开与载体无关」正是我们 feed 缺的那层（feed.js:20-21）；**T-02**（容错 JSON + 错误三分类）写进 C0 事件契约文档；**T-06** 的 hello 握手若要，作为新端点/新 feed 事件在本片定契约（不动存量，decouple:176）；**N-01**（attributionHeaders 漂移）建议与本片同批定（注册壳传真实身份，或明确接受并记录）。

### 3.3 S3：C0.3 fake-host 抽取与契约化测试分层迁移

- **内容**：`test/fake-host.js` 按 C0.2 接口供给 20+ 服务语义默认实现；`test/fake-ctx.js` 保留为注册面薄壳或废弃（开工时定）；逐文件迁移。分层基数（:121-125）：L1 纯逻辑 64 文件/437 静态例（含 5 个 jsdom 测试来源改 ds-bot devDeps）；L2 契约 39 个 fakeContext 用户文件统一换 fake-host；L3 语义耦合——`browser-plugin-output.test.js` 的 fake-host 同形供给迁移闭环（守卫 ALLOWED 注明「C0.3 moves it to the fake host」，check-dsh-imports.mjs:13）+ 闭包内断言 DSH 词表的文件；L4 端到端留作 C0.4 双跑。纪律：只换供给不改断言，断言要改必须单列说明（:153）。
- **开工判据**：C0.2 接口定稿；C0.1 完成（闭包清零口径见拍板项 P-02）。
- **完成判据**：无 `dev/harness` 的环境下 `npm test` 1133 例全绿；CI 主测试不再依赖 harness 安装（harness 此后只服务 `dev/contract/` 行为锁定与 `rt/dsh.js`）。
- **依赖**：C0.1、C0.2。
- **估时**：7–10 天（:128）。
- **风险**：fake 服务语义与 DSH 真实行为的偏差被测试固化——用行为锁定测试约束关键语义；大批量迁移掩盖单文件回归——按文件小批提交。
- **对标修改**：**T-17/T-18**（渲染期降级、诊断面）若拍板，其测试供给走 fake-host 同形路径；**T-06** 的 hello 在 fake-host 上要有对应 fake 服务；本片同时处理 §1.2 差距 4/5 的四处行为分歧台账——要么补锁定测试，要么单列记录为已知分歧（拍板项 N-02）。

### 3.4 S4：C0.4 双跑 golden master

- **内容**：`dev/golden-diff.mjs`（归一化补全 + step diff + mask 规则 + 人可读差异报告，含非零 exit code 供 CI）；基线 `dev/golden/<scenario>.json` 进 git；**Windows/CI 可执行入口** `dev/golden.mjs`（node `child_process` 管理 mock 与 `dsh web` 两进程；pid 文件 + 进程树终止替代 `setsid` 进程组；不经 sh）；场景先做审批 + 压缩（决策 6 范围）；tracer bullet（自有 turn 驱动 + `agent.session.append` + `sessions.flush` 写回，读面全留 DSH，不是循环重写）。
- **开工判据**：C0.2 对象面契约可用；双跑载体拍板（建议 npm 包路线 + 开工前 spike 验证 profile/patch 等价性，:137）。
- **完成判据**：一键命令在本机 Windows 与 CI 各产出「DSH 循环」与「tracer bullet」两份转录 + 差异报告；审批与压缩两场景两边可跑；**差异=0 作为进 C1 的门槛**（decouple:112）。
- **依赖**：C0.2；C0.1（新增场景代码不得新增 DSH import，过 CI 守卫）。
- **估时**：8–12 天（入口 3–5 + diff/基线 3–4 + 场景 2–3，:142）。
- **风险**：npm 包形态下 profile/patch 等价性未验证（spike 先行，失败则回退 WSL/checkout 路线并重估）；归一化过粗掩盖真差异、过细造成误报——以「人可读差异报告」为验收口径。
- **对标修改**：**T-05**（协议探针）排在本片之后——没有可比对基此前探针无从对拍；**T-23**（就绪两段判定、健康检查契约、优雅停止阶梯、进程归属按身份）进 `dev/golden.mjs` 的进程管理设计，与 `app/src/host-process.mjs:65-74` 现结构（10s 后 kill、再 5s SIGKILL）同源改进；**T-26**（崩溃分类 + 安全模式）若拍板项 P-03 判要，则本片加「崩溃恢复 + seq 重算」场景并上浮 2–3 天（:183）。

### 3.4b S4b：C0 账号评估（自研 OAuth / token 服务评估 + 保底路径）

> 本片是修订时补入的：解耦设计 decouple:140 明确要求「C0 产出『自研 OAuth / token 服务』评估（含 `auto` 联网搜索的账号 token）作为 C 的 gating 输入」，而 C0 执行基线的四个切片（c0-execution-baseline.md:87-144）与本文修订前的编排均未收录——不补则 C 可能在账号路线未定时开工，B1 发布阻断项（decouple:140 末句）也没有触发点。

- **内容**：产出评估短文（进 `docs/plans/` 或 `docs/dev/`）：现状（B1 沿用 DSH 账号服务 `dsh-deepseek-account` / `dsh-llm-deepseek-account`，自有 UI 复刻登录入口，`src/host/account.js` 全部转发、零 patch；`app/src/profile.mjs:28-41` 的 `/oauth/callback` 承载行）；自研范围（OAuth 流程 + loopback 回调 + token 存储 + `auto` 联网搜索的账号 token）；成本结论二选一——「C 阶段自研」或「保底：弃用账号登录 + API key 迁移引导（README / CHANGELOG 前置声明）」。
- **开工判据**：无（可与 S2–S4 并行；输入 = B1 已落地的 account 四端点与 profile 回调行，ROADMAP.md:148-151）。
- **完成判据**：评估短文落库并明确二选一的结论与理由；若走保底，「纯账号用户的升级路径写进发布说明」列入 B1 发布阻断项（decouple:140 末句）；结论同步进 ROADMAP 决策日志与 §3.7 的进 C1 门槛。
- **依赖**：B1-2/B1-3（已落地）；与 C0 各片无代码依赖。
- **估时**：未在先文档中给出；本计划建议 2–3 天（标注为本计划建议，非文档口径）。
- **风险**：漏评 = C 的 gating 缺一项（本文修订前正是如此）；评估若判「自研」，其 token 机制可直接参照 A-03（短时 access + 轮换 refresh + 家族吊销）与 A-04（威胁模型写清楚），不必从零设计。
- **对标修改**：无直接对标项改变本片存在性（存在性由 decouple:140 决定）；A-03/A-04 是评估「自研 token 服务」时的现成参照。

### 3.5 S5：B1-4 配置迁移

- **内容**：插件 config 旋钮 **29 处读取 / 19 键**（ROADMAP.md:83-85，2026-10-23 实测）从 DSH 的 profile/patch 机制迁到 DS Bot 自己的配置文件；含「插件形态（web 端）与 app 形态双配置源如何合并」——需单列设计（decouple:85）。这是 B1 主线唯一未动工的代码项（ROADMAP.md:151 剩余清单）。
- **开工判据**：双配置源合并设计出并过维护者评审；B1-3 已落地（own/rollback 双 profile，ROADMAP.md:148）提供迁移的对照面。
- **完成判据**：19 键全部有自有配置源与默认值；插件形态与 app 形态读同一份配置；`cordis.patch.yml` 不再承载业务旋钮；迁移不丢用户既有值（一次性迁移 + 幂等标记，同 home-move 模式，ROADMAP.md:137）；单测 + 真机两形态各跑一轮。
- **依赖**：B1-3（已落地）；与 C0 无硬依赖，但新配置文件代码若先落，按 C0.1 收口纪律走 vendor + rt（c0-execution-baseline.md:175）。
- **估时**：**未估**——输入清单已备（ROADMAP.md:83-85），合并设计出后再估；本文不编数。
- **风险**：双源合并是配置语义问题（patch 覆盖优先级、app 注入、缺省值三级）；漏一键则用户设置静默丢失——按 19 键逐键列对账表。
- **对标修改**：无直接对标项改变本片；T-24（更新链）与 T-27（versionCode）属 B2 发布面，不在本片（§3.7）。

### 3.6 并行轨道（不受解耦主线阻塞）

**S6 proactivity P0 + P1**（本计划输入的剩余任务盘点 §parallelTracks 第一条）
- 内容：P0 目标与进展（`state.goals`/`state.live` + 五工具 + 回合结束生成 live，1–2 周，proactivity:222）+ P1 提案（2–3 周，:223）；store 一次 `adopt()` 扩展（`state.goals`/`state.live`/`state.proposals` 与 W-B1 `state.profile`、W-B2 价值观合并，`state.version` 仍为 1——`store.js:96` 只认 `version === 1`，本会话 sed 实证；c0-execution-baseline.md:174）；新文件（`goals.js`/`live.js`/`proposals.js`）一律 import vendor 薄替代、经 rt 取服务（:175）。
- 开工判据：proactivity 8 条拍板（尤其第 1/2/4/8 条，proactivity:377-384 的待拍板清单）；C0.1 收口（vendor 在位）——若新代码先于 C0.1 落地，自动进入 C0.1 收口清单，无二次返工灰区。
- 完成判据：按 proactivity:222-223 的验收列（P0：建目标 → Bot 能读到 → 回合结束 live 更新 → 另一 Bot 用 `list_bots` 看到；P1：mock 全链路 + 缺三维字段被拒 + 超范围动作走审批 + 拒绝/过期不自动执行）。
- 依赖：无硬依赖（P0/P1 完全不依赖定时器，proactivity:230 留了退路）；与 C0.2 的接触点是 rt 取服务，排在 C0.1 之后即可。
- 估时：P0 1–2 周 + P1 2–3 周（proactivity:222-223）。
- 风险：与 C0 改同一批热点文件（`turns.js`/`parts.js`/`memory.js`/`store.js`）——按上游跟进纪律「新文件优先、少动既有行」（proactivity:237）；P1 提案卡与视图卡规则交互（每会话一条、新覆盖旧，proactivity:165）。
- 对标修改：**A-05**（一行上下文形态）adopt 为 P1 客户端面板/提案卡的形态候选——但必须维护者拍板是否松动 proactivity:303「不是界面」这条已定边界（拍板项 N-04）；照形态不照语义。**T-29**（notify 节流与免打扰粒度）落 P1 提案卡与主动回合的呈现/关闭开关——系统通知属 app 壳，P0 阶段只做进程内呈现，通知留待 W-A1/D；锁屏脱敏复用 T-15 的打码三类，节流数值按我们的主动回合频率重定。

**S7 borrowings 批次 A（W-A1..W-A4）**
- 内容：W-A1 托盘常驻/开机自启/系统通知（2–4 天）、W-A2 工具操作轨迹 `audit.js`（2–3 天）、W-A3 `secrets.json` 落盘加密（2–3 天）、W-A4 浏览器坐标操作（1–2 天）（borrowings §4.3，:337-371）。W-A5「主动性拍板材料」**不列入剩余工作**——borrowings §4.3 该条自述「估时：0.5 天（已随本文产出）」，其产出就是 §九 决策单（borrowings:500-510），再排即重复计数。
- 开工判据：无拍板依赖（borrowings:26、:337）；P-04 属 app 壳改动许可范围（borrowings 决策单第 3 条）。
- 完成判据：按 borrowings §4.3 各片验收（关窗后托盘、轨迹文件出现对应行且 `DSH_SECRET_*` 值不出现、mock 轮次、app/ds-bot 单测全绿）。
- 依赖：无；与 C0 唯一相邻面是 W-A3 复用 `llm.js` 的 vault 密钥管理（borrowings:353-355；c0-execution-baseline.md:93）——`llm.js` 同时是 C0.1 拆壳对象，W-A3 须在 C0.1 收口后动，或接受二次收口。
- 估时：合计 7–12 天（分项 2–4 + 2–3 + 2–3 + 1–2 之和；W-A5 已产出不计）。
- 风险：W-A1 属 app 壳（Windows 通知需要 AppUserModelID）；W-A2 落盘前必须过脱敏（硬规则 2）。
- 对标修改：**T-28**（argv 按 key 名脱敏、通知按语义分层可停止性）并入 W-A1/W-A2 的验收；**T-15**（打码三类）与 W-A2 共用同一套脱敏规则但落点不同（audit 落盘前 / 导出分享在 C 阶段），不合并范围。

**S8 W-B 与 store 同批**
- 内容：设计类切片 W-B5 混合检索（设计 2 天；若实施含新文件 `memory-index.js`）、W-B6 入口网关设计、W-B7 端云 v1 设计——以设计为主，C0 期间随时可做（c0-execution-baseline.md:173）；W-B1/W-B2/W-B3 与 P0/P1 字段一次 `adopt()`（:174）；W-B3 失败复盘落 `memory.js` 的 lesson 记忆，不进 store 批次。
- 开工判据：设计类无依赖；W-B1/B2 随 S6 同批；W-B4（`ask_bot`）边界未拍板，**不排期不并行**（:176）。
- 完成判据：设计类出 docs/plans 短文；store 同批一次 `adopt()` + `state.version` 仍 1 + 迁移测试；W-B5 若实施，「召回示例通过」。
- 依赖：S6 同批；C0 数据面已降 C2 前置（决策 6，:151）——「同批迁移」的准确含义是「同一个 store.js 批次」，不是「依赖 C0 的 version 链」。
- 估时：W-B5 设计 2 天（borrowings §4.4 行内口径；其 §4.8「设计类」与 §4.4 行内口径不一，:173 已标注）；其余见 borrowings。
- 风险：store 模板多批小改 → 合并为一次（:174）。
- 对标修改：**T-15** 打码三类同时服务导出/分享/轨迹三个面；**T-19**（白名单+降级）为 W-B6 入口网关的设计参考；**T-25**（plugin-kit 三件套）为 W-B7/C3 生态的参照。

**S9 ROADMAP §四 既有并行轨道**
- 配置层盘点：产出即 B1-4 输入（已备，ROADMAP.md:83-85）——本计划把它列为 S5 的输入而非独立工作项。
- UI/外观：`--bt-*` 令牌 + `style-debt.json` 只降不增 + `motion.js`，入口 `src/client/styles.js`（ROADMAP.md:86-90）。对标修改：**T-16/T-17/T-18**（widget 视图分档/渲染降级/诊断面）落在这一轨的 widget-views.md 修订里（T-17 需拍板，N-05）；**T-21**（整轮折叠规则）归客户端消息流。改造前必读其脆弱点：client 800+ 行 CSS 大量耦合 DSH 未文档化 DOM 子串选择器，改 UI 时优先收敛（ROADMAP.md:88）。
- fleet CLI 接入：无设计文档，动手前先写 `docs/plans/<date>-<topic>.md`（ROADMAP.md:91）。
- 发布链：B1 起自建（ROADMAP.md:92）。对标修改：**T-24**（更新链四条）与 **T-22**（manifest checklist）、**T-27**（versionCode）并入 B2 发布链设计——注意我们已拍板 Windows 不签名、macOS ad-hoc（decouple:142），所以只能到「SHA-256 必须」这一层，「不签名 = 清单与包可被同时篡改」必须写进 README/发布说明，不能假装有签名兜底。

**S10 上游同步（贯穿）**
- 每周 1–2 天、计入资源预算（ROADMAP.md:101）；C 动工前最后一次 `upstream/dev` merge，只取 `ds-bot/` 与 `docs/plans/`（decouple:149）；冲突热点分两处记载：上游侧 `ds-bot/client.js`、`state.json` 迁移链（store.js）、CHANGELOG.md（ROADMAP.md:97），fork 改动侧 `turns.js`/`memory.js`/`parts.js`（proactivity:237）——本文此前的「llm.js/parts.js/store.js/channel.js（ROADMAP.md:97）」系出处张冠李戴，修订于此；本分支的 `llm.js`（C0.1 拆壳对象）与 `channel.js` 是 fork 自有热点，无上游冲突记载，按「新文件优先、少动既有行」跟进。
- 对标修改：无。dsh-go 调研本身不改变同步纪律；但要注意我们已 0.2.2 而它钉 0.2.1-rc.4/rc.2，对照行为前先核对 API 面（前次调研 §七已提过）。

### 3.7 阶段门槛（C / B2 / D）

| 阶段 | 门槛（开工判据） | 出处 |
|---|---|---|
| 进 C1（循环本体） | **C0.4 双跑差异=0**（审批 + 压缩两场景）+ **C0 账号评估产出**（decouple:140：自研 OAuth/token 服务评估作为 C 的 gating 输入，含 `auto` 联网搜索的账号 token；保底路径 = 弃用账号登录 + API key 迁移引导）——即 S4b | c0-execution-baseline.md:141；decouple:112,140 |
| C2（会话存储） | C1 + 「id 不变 + seq 单调度量」不变式冻结 | c0-execution-baseline.md:148-149 |
| C3（工具面） | C1 + C0 契约层；生态三档按「独立化前置」实施 | decouple:119,144 |
| C4 / C5 | C1（分段切换与 usage 收自家循环） | decouple:120-121 |
| C6（测试策略） | C0.2/C0.3 完成 | c0-execution-baseline.md:119-130 |
| B2（去 DSH 宿主） | C 完成 + `src/client` 的 DSH client-bundle 依赖有着落（§1.2 差距 7：dsh-primitives.js:3 / user-message.js:2 的 import 与 speech.js:4 的字符串引用） | decouple:93,96 |
| D0（移动端可行性） | 真机 + 同一可信网络环境（**用户侧**） | decouple:130 |
| D1（Capacitor） | D0 验证通过；路线已拍板 Capacitor | decouple:130-131 |
| D2（网络与安全） | D0/D1 + 安全模型设计；**对标 T-07…T-14 与 A-03/A-04 集中落点** | decouple:132 |
| D3（范围） | D1/D2 + 真机 iOS + Android 各一（**用户侧**） | decouple:133-134 |

D 的全部对标项（A-01…A-04、T-02…T-14）都排在 D0 验证之后，不提前占用 C 的名额；R-02（托管链接）明确不做。

## 四、待用户与待拍板事项

### 4.1 待用户（6 项，无一项因本计划解除）

| # | 事项 | 出处 | 本计划后的状态 |
|---|---|---|---|
| U-1 | 真机取证（桌面 app OAuth 登录/登出截图 + 两屏补拍 + 回滚回归） | ab1-closeout.md:65-69 | 未变 |
| U-2 | npm Trusted Publishing 配置 | ab1-closeout.md:71-75 | 未变 |
| U-3 | 阶段 A 真实自托管端点端到端 | ab1-closeout.md:77-81 | 未变 |
| U-4 | smoke 台架（checkout + POSIX） | ab1-closeout.md:49-55 | **部分改变**：C0.1 风险栏要求拆壳后过 smoke（c0-execution-baseline.md:100），本机不可跑（§1.2-6 实跑验证）——S1 完成判据④改为「未跑 smoke 不得标记 C0.1 完成，合并前需维护者明确接受或安排可跑环境补跑」，替代路径（C0.4 的 Windows 可执行入口，ab1-closeout.md:63）是 8–12 人日后的产物、不能充当本次判据 |
| U-5 | Linux/macOS `dev/check.sh` | ab1-closeout.md:83-87 | 未变（本会话未尝试） |
| U-6 | PR CI 查看 | ab1-closeout.md:89-98 | 未变（代理拒绝；本会话按口径未重试） |

### 4.2 待拍板（既有 9 条 + 本计划新增 8 条）

**既有（逐条标注是否因本计划改变）**：

| # | 事项 | 出处 | 状态 |
|---|---|---|---|
| P-01 | 双跑入口载体（npm 包路线 vs WSL vs 补 checkout） | c0-execution-baseline.md:180 | 未变；S4 开工阻塞 |
| P-02 | C0.1 注册壳例外口径（验收第 2 条「脱离」按测试闭包计 53→0，注册壳是否算例外） | :181、:97 | **2026-10-30 已拍板（用户授权「按建议执行」）：接受注册壳例外（出路 a）**——「脱离」口径改为「`src/host` 业务代码 0 + 守卫强制 + 注册壳单点例外」，闭包实测 39（1 直连 + 38 经 `index.js:8→llm-dsh.js`）即为该口径下的达成态；出路 b（C0.2/C0.3 让测试经 fake-host 供给 `LlmAdapter` 基类）留 C0.3 范围，S3 开工判据「C0.1 完成（闭包清零）」按本口径改写 |
| P-03 | 崩溃恢复与可观测性是否在 C0 内补设计 | :182 | 未变；T-26 提供参考口径，若判要则 S4 加场景 +2–3 天 |
| P-04 | 重算/回填工具与导出快照回滚窗口的归属 | :183 | 未变（基线按随数据面降 C2 处理并送确认） |
| P-05 | 三个开工时小决策（vendor 命名位置 / 守卫实现位置 / fake-ctx 去留） | :184 | **因 C0.1 工作落地而部分清账**：vendor 命名位置已定（`src/host/vendor/`，本会话 ls 实证四文件）、守卫实现位置已定（`scripts/check-dsh-imports.mjs` + `test.yml:42` 新步骤）；剩 `test/fake-ctx.js` 保留或废弃（S3 开工时定） |
| P-06 | C0 依赖清单与基线 §二 口径修正的评审 | :162 | 未变；S2 开工判据 |
| P-07 | proactivity 8 条待拍板 | proactivity.md:377-384 | 未变；S6 开工判据 |
| P-08 | borrowings 决策单 9 条 | borrowings:500-510 | 未变；S7/S8 触发条件 |
| P-09 | W-B4（`ask_bot`）边界裁决 | c0-execution-baseline.md:176 | 未变，明确不排期不并行 |

**本计划新增（N-01…N-08）**：

| # | 事项 | 证据 | 建议 |
|---|---|---|---|
| N-01 | `attributionHeaders` 身份漂移的处理口径 | `vendor/llm-errors.js:36` 硬编码 `version:'0.0.1'`；`llm.js:467`/`:775` 无参调用；DSH 默认身份 `deepseek-harness/<包版本>`（读 `dev/harness/.../dsh-llm/lib/index.js:855-859` + `lib/types/attribution.js:14-20`，实装 0.2.1-rc.2） | (a) 注册壳把真实身份传进 llm.js（改签名）——建议，与 S2 同批；(b) 接受 0.0.1 并在文档记录「自有 provider 线序的 UA 不报 DSH 版本」；(c) 读 package.json 版本 |
| N-02 | 四处行为分歧的处理口径（BlockAssembler 两处、session-reference 坏 payload、LlmError failure、fileHandleText 空串路径） | §1.2 差距 4/5。LlmError 一处的准确刻画：vendor 把第三参原样 spread 且不冻结，DSH 是「校验白名单 + `Object.freeze`」（本会话实读 dsh-llm 的 LlmError 构造）——差异是校验与冻结，不是「留不留字段」 | 前两处有真实消费面（九个 `ctx.llm.stream` 调用点吃 DSH 生产者形状），建议 S3 台账补行为锁定测试；LlmError/fileHandleText 两处 src 内不可达（6 处 `new LlmError(` 全两参、fileHandleText 只传 undefined），记录为已知分歧即可，优先级低 |
| N-03 | hello 版本握手（T-06）是否采纳为新增端点/新 feed 事件 | dsbotCoverage ②（7 项 mobile API 我们有/无的盘点）；`git merge-base --is-ancestor 6f3e1b3 HEAD` 为否（本会话实跑） | 采纳最小形状（api/apiMin/apiMax/capabilities/boot/seq），不动存量 29 端点（decouple:176）；上游 mobile API 保持不合入 |
| N-04 | proactivity「不是界面」边界是否为一上下文形态松动（A-05） | proactivity:303、:52 已定边界 vs A-05 形态候选 | 只作 P1 客户端面板/提案卡候选；不默认执行；若松动需同步改 proactivity 文档 |
| N-05 | widget 渲染期降级第二道闸（T-17）是否拍板 | widget-views.md:35 的原子拒绝是有理由的已定设计 | 双闸（登记期原子拒绝 + 渲染期降级）需维护者拍板；分档上限（T-16）也要先证明存在「工具卡之外的承载位置」 |
| N-06 | NOTICE 补登记「dsh-go (AGPL-3.0)：设计参考，未使用其代码」+ 厘清 obelisk AGPL 行的措辞与归类 | NOTICE:85-103 体例；NOTICE:98 的 obelisk 行（本会话 `git grep -in agpl -- NOTICE` 实证） | 登记设计来源与代码引入分开表述；obelisk 行是依赖声明还是代码引入需维护者确认（只读未改） |
| N-07 | CI 守卫扫描范围扩到包根（`web-search.js`/`index.js`/`scripts/`） | `check-dsh-imports.mjs:31` 只走 `src/` 与 `test/`（本会话读源码实证）；`web-search.js:11` 是 C0.1 carrier 之一 | 随 S1 或 S2 落地（本计划建议，无文档依据） |
| N-08 | 本次 dsh-go 调研的出处归档（待办，循前次安卓调研之例） | §二 41 条的行号级出处（carrier.dart:34-70、README:134、THIRD_PARTY_NOTICES.md:97-118 等）指向只读浅克隆 `bb52f091`，该克隆不在仓库内，本仓任何人目前无法复现——按本文自定的三档证据口径，这批出处缺「可复现」一档 | 固化为 `docs/dev/<日期>-dsh-go-<主题>-survey.md`：记录 commit `bb52f091`、克隆与只读步骤、未执行声明（前次之例：dsh-go-android-survey.md 记 APK SHA-256 与静态口径，提交 `8ca4686`）。本文不代做（只写计划） |

另记两条**已过期/需更新的事实**：①ab1-closeout.md:6 的提交提醒只列 1 个已修改（`docs/plans/README.md`）+ 2 个未跟踪（proactivity、personal-agent-borrowings），现在未跟踪项是 9 个（§1.2，含本文）——提交 C0.1 时以本文清单为准；②C0 执行基线的切片表未收录 decouple:140 要求的账号评估，本计划以 S4b 补上（§3.4b），建议基线文档下次修订时同步。

## 五、一致性核对：本计划没有违反的不变式与红线

| # | 不变式 / 红线（出处） | 本计划如何遵守 | 核对结论 |
|---|---|---|---|
| 1 | 不改 client 的 `api/bot` 协议（decouple:176） | A-01/A-02 是「冻结 + 保留」；T-06 只作为新增端点/新 feed 事件；T-10 的 allow-list 是现有 83 个 case 的子集裁剪 | 无违反 |
| 2 | 不 patch DSH、不依赖 DSH 安装内文件（AGENTS.md 硬规则 1） | R-01 全线否决 10 个补丁；route-guard 的合规替代三条（推动上游 / 自有网关 / phase C）；T-23 改的是 app 自己的进程管理 | 无违反 |
| 3 | 只原创材料 / 许可兼容代码（硬规则 3） | AGPL 部分零复制（§2.0 边界）；MIT 的 plugin-kit 默认不复制；A-06 把设计借鉴登记写成明例、A-07 把入仓红线操作化；品牌素材不用 | 无违反 |
| 4 | C0 完成前不动循环重写（decouple:179） | S4 的 tracer bullet 是唯一允许形态：只驱动 turn + 写回事件，读面全留 DSH（c0-execution-baseline.md:150） | 无违反 |
| 5 | 会话 id 不变 + seq 单调度量（:148-149） | S4 双跑 diff 把 seq 作硬校验；写回路径只 append；本计划无任何重生成 id 的改动 | 无违反 |
| 6 | 数据面 version 链与 JSONL fixture 是 C2 前置（决策 6，:151） | S6/S8 的 store 同批只加字段、`state.version` 仍为 1（store.js:96 实测只认 version===1）；C2 从「version:1 + 这些字段」起步，无二次迁移 | 无违反 |
| 7 | 测试迁移只换供给不改断言（:153） | S3 纪律原文沿用；四处行为分歧的处理单列拍板（N-02）而不是默默改断言 | 无违反 |
| 8 | 不碰 `~/.dsh` 与用户数据（硬规则 5） | T-05 探针只打 `.dsh-test-<name>/` 台架；T-23 的进程归属判定只用于我们自己 spawn 的进程 | 无违反 |
| 9 | 无 secrets（硬规则 2） | T-05 用 `dev/mock-llm.mjs`；T-15/T-28 的打码与脱敏是下游防线 | 无违反 |
| 10 | `client.js` 禁手改 | `--check` 门本会话实跑 exit 0（§1.1）；本计划不含 client 手改 | 无违反 |
| 11 | 改 `index.js` 或 `src/host` 必跑 smoke（ROADMAP.md:106） | C0.1 拆壳动了 `index.js:8` 与 `src/host/llm.js`，smoke **未跑**且本机不可跑（§1.2-6 实跑验证）——如实记录为未决，S1 完成判据含「可跑环境补跑」 | **未决（有记录，非违反但未闭环）** |
| 12 | 宣传口径红线（decouple:178-182） | 本文不宣称「app 里没有 DSH」、不把「无 DSH 进程」当判据、不承诺 C 的工期、不宣称「完全解耦」 | 无违反 |
| 13 | P0/P1 不动 `app/`（本计划输入的剩余任务盘点 §parallelTracks） | S6 全部落 `ds-bot/`；A-05 的界面形态候选用「插件侧栏/面板与 list_bots 的 live 行」，不牵动桌面 app 壳 | 无违反 |
| 14 | README 与 README.zh.md 同步（AGENTS.md 风格节） | T-14 降级表两份一起改；T-24 的「不签名」说明两份一起写 | 无违反 |
| 15 | commit author 必须是人、不加 AI Co-authored-by（ROADMAP.md:108） | S1 提交纪律照旧；本文不产生提交 | 无违反 |
| 16 | AGPL 代码不进仓库 | §2.0 许可边界 + R 项全部零复制；A-06/A-07 的登记与入仓纪律；NOTICE 只登记设计参考（N-06） | 无违反 |
| 17 | 不留兜底上限、治理靠结构（ROADMAP.md:109） | T-19 的「白名单 + 点按/审批后才执行 + 违规降级」是治理结构，不是配额 | 无违反 |
| 18 | 账号路线：B1 保留 DSH 账号服务、**C0 产出自研 OAuth/token 服务评估作为 C 的 gating 输入**，保底 = 弃用账号登录 + API key 迁移引导；B1 发布阻断项 = 纯账号用户升级路径写进发布说明（decouple:140；已定决策 3，:202） | 修订前本计划漏收此项（C0 四片、进 C1 门槛、核对表均无）；修订后补 S4b 评估片（§3.4b）+ 进 C1 门槛一行（§3.7）+ 本行 | 修订后无违反（原稿漏项，已补） |
| 19 | B2「DSH 从安装包消失」时 `client.js` 的构建（AGENTS.md 硬规则 4）不能留着无着落的 DSH client-bundle 依赖 | §1.2 差距 7 立台账（dsh-primitives.js:3 / user-message.js:2 的 import、speech.js:4 的字符串引用、vite resolveId 只覆盖自有窗口构建）；§3.7 B2 门槛含「有着落」 | 无违反（已列入门槛） |

## 六、建议的 ROADMAP 决策日志条目

以下为建议条目文本（按 ROADMAP §七 现有体例写）；**本文只写在文档里，未改 ROADMAP.md**，是否录入由维护者决定。

> - 2026-10-30（C0.1 代码面完成于工作区未提交；dsh-go 调研入计划）：`feat/a-own-llm-core` 工作区落地 C0.1 主体——`src/host/vendor/` 四个零语义薄替代（`messages.js`/`tools.js`/`web.js`/`llm-errors.js`；20 处 import 站点改指，本会话 grep 实证）、`llm.js` 拆壳为工厂 `botLlmAdapter(Base)`（llm.js:701/781/787）+ 注册壳 `src/host/llm-dsh.js`（src 内唯一保留 `@deepseek-ai/dsh-llm` import 的文件，index.js:8 改指）、import 守卫 `scripts/check-dsh-imports.mjs`（ALLOWED 4 项各带理由）+ `test.yml:42` 新步骤、测试侧 3/4 直连文件词表映射（新增 `test/session-reference.js`）。**五门本会话实跑**：ds-bot 1133 例 / 1132 过 / 1 跳 / 0 失败、app 99/99、lint 0 错误（15 警告）、`client.js --check` 过、守卫过；`npm test` 直接调用被操作系统拒绝，跑 package.json 同条 node 命令。**闭包复跑**（C0 基线 §附同款算法）：117 个测试文件 39 个 import 阶段可达 `@deepseek-ai/*`（1 个直连 `browser-plugin-output.test.js` + 38 个经 index.js:8→llm-dsh.js），距 C0.1 完成判据「0」差注册壳例外口径（c0-execution-baseline §七.2 待拍板）。**smoke 未跑**：本机 setsid 缺失、三处 deepseek-harness checkout 均不存在、DSH_HARNESS 未设（本会话实跑验证）。dsh-go 四面调研结论入 [`docs/plans/2026-10-30-dsh-go-borrowings-and-orchestration.md`](docs/plans/2026-10-30-dsh-go-borrowings-and-orchestration.md)：其 Dart 客户端独立复现我方 api/bot 契约（其副本内官方 v0.2.3 应答夹具与 channel.js:518/feed.js:45 逐字一致）——采纳「冻结 api/bot 现有形状 + revision/modelsKey 双键保留」；其 10 个 DSH 构建期补丁全线否决（硬规则 1，route-guard 的洞推动上游或以自有网关/phase C 解决）；AGPL-3.0 部分零复制，只提炼思想并登记 NOTICE。**新增拍板/待办 8 条**见该文 §4.2（N-01 attributionHeaders 身份漂移、N-02 四处行为分歧口径、N-03 hello 握手、N-04 proactivity「不是界面」边界、N-05 widget 渲染期降级、N-06 NOTICE 登记、N-07 守卫扫描范围、N-08 dsh-go 调研出处归档）。剩余任务编排：C0.1 收尾提交 → C0.2（5–8 天）→ C0.3（7–10 天）→ C0.4（8–12 天，双跑差异=0 是进 C1 门槛之一）+ **C0 账号评估（decouple:140，S4b，2–3 天建议值，进 C1 门槛之二）**；B1-4 配置迁移输入已备（29 处 / 19 键，ROADMAP §四）；并行轨道 P0/P1 与 W-A/W-B 照旧，store 新字段一次 adopt()。

## 变更

- 2026-10-30：建立本文。输入：本工作流的 dsh-go 四面调研（协议客户端 / DS Bot 通道覆盖 / 远程连接 / runtime 与功能生态）、仓库未提交改动盘点与剩余任务盘点；质量门五门与闭包、守卫范围、attributionHeaders 出处等为本会话实跑/实读（§一）。本文是规划文档，不改变任何已定设计；除本文外未改其他文件。
- 2026-10-30（同日修订，按独立审读意见逐条核处）：①工作区计数改实（22 个已修改 + 9 个未跟踪，第 9 个是本文；ab1-closeout.md:6 实列 1 改 + 2 未跟踪），S1 提交面与风险①随之改「5 份未跟踪规划文档」；②「llm-dsh.js 是 src/ 内唯一 DSH import」改准为「`src/host/` 内唯一」，并把 `src/client` 的 DSH client-bundle 依赖（dsh-primitives.js:3 / user-message.js:2 / speech.js:4）立为差距 7 与 B2 门槛；③补 S4b「C0 账号评估」片（decouple:140 要求、基线与本文初稿均漏收）并进 §3.7 进 C1 门槛与 §五核对；④T-06 的 mobile.js 证据改为本会话从仓库根实跑的真实输出（2 个提交仅在 remotes/upstream/feat/mobile-api 可达 + merge-base 退出码 1 + 不在 HEAD/工作树）；⑤合计改实：C0 四片 20.5–31 人日（口径差说明保留基线 23–35 的来历），S7 改 7–12 天并剔除已随 borrowings 产出的 W-A5；⑥LlmError 分歧改准（DSH 是「校验白名单 + Object.freeze」而非「只留 {message, code}」）；⑦`ctx.llm.stream` 消费点改全 9 处（补 images.js:189、secrets.js:518）；⑧S1 完成判据③改条件式（附 P-02 不获批时的两条出路）、④加「未跑 smoke 不得标记完成 + 需维护者确认」；⑨S10 冲突热点出处改准（ROADMAP.md:97 与 proactivity:237 分工）；⑩新增 N-08 调研出处归档待办。审读意见全部采纳（其中问题 1/2/4/6/7/10 为事实更正，3/5/8/9 与三条 missing 为补漏）；无保留项。
- 2026-10-30（S1 执行，按用户「按建议执行」授权）：①P-02 拍板接受注册壳例外（§4.2 与 S1 判据③ 的条件式随之落定），「脱离」口径 = `src/host` 业务代码 0 + 守卫强制 + 注册壳单点；②N-01 已修复——`llm-dsh.js` 导入 `APP_IDENTITY` 传入 `llm.js` install，adapter 与 `discoverWireModels`（providers.js:258 经 `rt.ownIdentity`）的 User-Agent 恢复拆壳前身份，另补 4 条行为锁定测试（身份锁 + BlockAssembler 两处 + session-reference 坏 payload，均注「已知分歧的锁定」）；③S4b 账号评估落库 `docs/dev/2026-10-30-c0-account-evaluation.md`（结论：建议 C 阶段自研，三条改判触发条件；实质发现 `dsh-deepseek-account-platform/lib/types/protocol.d.ts` 类型化 wire 协议，OAuth 成本中-高→中）；④C0.1 代码面与六份规划文档提交于 `feat/a-own-llm-core`（S1），smoke 未跑（本机不可跑）如实记入提交信息。

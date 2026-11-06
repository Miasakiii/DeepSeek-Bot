# A/B1 收尾包（2026-10-27）

- 范围：阶段 A（自有 LLM 层）与阶段 B1（自有前端与自有出口）的收尾核对 + 一笔测试欠账清偿。
- 验收口径来源：[解耦设计](../plans/2026-10-22-decouple-from-dsh.md) §「阶段 A 的验收」（L70-75）与 §「阶段 B1」（L77-87）；最新进展以 [ROADMAP.md](../../ROADMAP.md) §七「决策日志」2026-10-24 之后各条为准。
- 证据口径分三档，逐行标注：**代码/测试已证**（本仓测试或代码行可查）、**真机已证**（决策日志记录的实机取证，本会话未复跑）、**本会话实跑**（本文写作时执行的命令，输出见各处）。
- 本次只改两个文件：本文档与 `ds-bot/test/account-channel.test.js`；不动 ROADMAP / CHANGELOG / README，不动其他代码。工作区另有与收尾无关的在先未提交改动（`docs/plans/README.md` 的 2 行目录登记，及未跟踪的 `docs/plans/2026-10-26-proactivity.md`、`docs/plans/2026-10-27-personal-agent-borrowings.md`），提交收尾包时须显式只 add 上述两个文件，勿 `git add -A`。

## a) 阶段 A 验收核对表

判据逐条对照解耦设计 L70-75：

| # | 判据 | 状态 | 证据 | 剩余 |
|---|---|---|---|---|
| A-1 | 三协议 mock 各覆盖正常流、usage、工具调用、max-tokens 截断、AUTH / RATE_LIMIT / 超时、密钥缺失，单测全绿 | 代码/测试已证（最近全量：2026-10-26 五门，ROADMAP 决策日志） | `ds-bot/test/llm.test.js` 22 例：AUTH 401→`auth` 不可重试（L130-135）、RATE_LIMIT 429（L131）、超时（L144-152）、max-tokens 截断（L61-70）、密钥缺失报 `MISSING_CREDENTIAL` 且不泄键值（L476）；`ds-bot/test/mock-wire.test.js` 6 例拉起真 mock/tap 子进程打三条 wire（正常流 / 工具调用 / usage / 401+400 / 日志同形 / tap 描述同形）。全量数字见决策日志 2026-10-24 第五切片（899/898/1）与 2026-10-26 复跑（1133/1132/1） | 无 |
| A-2 | 端到端（mock + 一个真实自托管端点）：新建 provider → 界面选中它的模型 → Bot 完成一轮 → 读图 / 记忆整理走通，全程不写 DSH 设置 | mock 侧已证；**真实自托管端点待用户** | mock 侧证据同 A-1（mock-wire 六例 + 决策日志 2026-10-24 第五切片）；真实端点一侧无任何记录 | LM Studio（127.0.0.1:1234）端到端，见 §d-4 |
| A-3 | 迁移 fixture：老用户 DSH provider 拷贝后不抛 `DUPLICATE_ADAPTER`，账号路由仍可用 | 代码/测试已证 | `ds-bot/src/host/llm.js` 注册时与 DSH 已占路由撞名则跳过该路由并告警（决策日志 2026-10-24 第二切片，ROADMAP L141）；防撞断言 `test/llm.test.js:375`；首启迁移 `moveOwnProviders` 幂等 + `providersMoved` 一次性标记钉死在 `test/providers.test.js:283-308`（决策日志 2026-10-24 第四切片，ROADMAP L143）；DSH 侧账号路由 / 套装提供商不动（同条） | 无 |
| A-4 | `npm test` + `build --check` + lint 全绿；DSH 账号登录路径回归通过 | 代码/测试已证（最近全量 2026-10-26，本会话未跑全量） | 决策日志 2026-10-26（ROADMAP L152）：ds-bot 1133 例 / 1132 过 / 1 跳过 / 0 失败、lint 0 错误、`--check` 过、app 99/99、UI 构建过；账号路径回归由 `test/account-channel.test.js`（本会话实跑 7/7 过）与 `test/account-dialog.test.js` 钉死 | 三门（ds-bot 全量单测 / `--check` / lint）已由工作流质量门补跑（§f）；app 单测与 UI 构建不在该输出中，最近记录仍见本行证据列（2026-10-26） |

## b) B1 验收核对表

判据逐条对照解耦设计 L86-87：

| # | 判据 | 状态 | 证据 | 剩余 |
|---|---|---|---|---|
| B-1 | 窗口 origin 是自有 server | 真机已证（决策日志 2026-10-25，ROADMAP L148） | `app/src/outlet.mjs`（稳定回环端口 + 每次启动新 token）与 `app/src/main.mjs` 把窗口 origin 换成出口 origin；真机验收「窗口 origin=出口 ✓、资产 200 ✓、UI 挂载 ✓」（ROADMAP L148） | 无 |
| B-2 | profile 无 `dsh-web-app` | 代码已证 + 真机已证（B1-3 落地） | `app/src/profile.mjs:10` `OWN_WINDOW_BUNDLES = ['@deepseek-ai/dsh-base', 'miasaki-dsbot']`；`:22` `RETIRED_BUNDLES` 含 `@deepseek-ai/dsh-web-app`；`:55-60` `claimBundles` 按模式重写 bundle 列表；前端服务四行 + `webserver`（仅承载 OAuth loopback 回调 `/oauth/callback`，`127.0.0.1:0`）经 `own-services.patch.yml` overlay 供给（`:32-43`）；首启检查 profile 收窄 dsh-base（ROADMAP L148） | 无 |
| B-3 | 一个 Bot 在自有 UI 里完成「发消息 → turn 跑完 → 流式渲染」 | 真机已证（决策日志 2026-10-25，ROADMAP L148-149） | 场景套件 `own-basic=pass`（ROADMAP L149）；CDP 截图确认侧栏 / Main Bot / 欢迎语 / 输入框渲染（L148） | 无 |
| B-4 | 群聊 / 详情 / 设置 / 搜索 / 审批各一张截图通过对比 | 部分真机已证（群聊 / 搜索 / 审批）；「设置」「Bot 详情」两项无记录、待补 | 决策日志 2026-10-25（ROADMAP L149）：场景套件 own-basic / group / approval / memory / search / view-card / updates 全 pass，CDP 截图取证（L148，仅侧栏 / Main Bot / 欢迎语 / 输入框）。记录中没有「设置」「Bot 详情」的场景名或截图，按本文开头的证据口径不把它们计入「真机已证」 | 「设置」「Bot 详情」补拍归入 §d-2 真机取证 |
| B-5 | 账号登录在自有 UI 可用 | 代码/测试已证；**真机取证待做** | 服务端 `ds-bot/src/host/account.js:28-83`（accountView / accountStart / accountCancel / accountSignOut 全部转发 DSH 文档化账号服务，零 patch；API 出处逐条对 `dsh-deepseek-account` 类型，决策日志 2026-10-25 L151）；通道四端点 `ds-bot/src/host/channel.js:183-190`；客户端 `src/client/account-dialog.js`（OwnSignInDialog，仅 `actions.ownSignIn` 存在时挂载，`:17`）与 `src/client/overlays.js:42,60`；OAuth 回调承载行 `app/src/profile.mjs:28-41`；2026-10-26 修复登录对话框 z-index 真 Bug（`calc(<length> + <integer>)` 非法取 `auto` 被设置对话框盖住 → 纯整数 `z-index:80`，`account-dialog.js:106`；决策日志 ROADMAP L152） | 登录 / 登出端到端真机截图（§d-2） |
| B-6 | 插件形态（DSH web）不受影响 | 代码/测试已证 | `ds-bot/src/host/outlet.js:7-8`（出口默认关闭，插件形态不受影响；DSH connection 路由不变并存，`outlet.js:3-4`）；`channel.js:531` DSH connection 路由保留；登录对话框仅自有窗口挂载（B-5 证据）；`test/outlet.test.js` 5 例钉死默认关闭等（决策日志 2026-10-24 B1-1 切片，ROADMAP L145） | 无 |
| B-7 | 回滚开关：保留 profile 切回 `dsh-web-app` 的开关 | 代码已证 + 真机已证 | `DS_BOT_OWN_UI=0` 整体回落（`app/src/outlet.mjs:25`、`app/src/main.mjs:104`），或缺 `ui/dist` 回落（`outlet.mjs:4`）；回滚模式 bundle 列表 `app/src/profile.mjs:11`（`DSH_WINDOW_BUNDLES`）与 `:70`（按模式选择）；真机回滚窗口 pass（`http://127.0.0.1:53033/`，ROADMAP L149） | 无（beta 通道先行属发布面，不在本次范围） |
| B-8 | `npm test` + lint 绿 | 代码/测试已证（最近全量 2026-10-26，本会话未跑全量） | 决策日志 2026-10-26（ROADMAP L152）：ds-bot 1133/1132/1、lint 0 错误（15 警告为上游存量）、app 99/99、`--check` 过、UI 构建过 | 全量由工作流质量门补跑（§f） |

## c) 本次清账：account 通道只读宿主断言补齐

- 欠账（主会话交底，本会话核实属实）：`ds-bot/test/account-channel.test.js` 的只读宿主用例只对 `account-state`（应答）与 `account-sign-in`（拒绝）断言，`account-cancel` 与 `account-sign-out` 两个变更端点缺同样的拒绝断言。
- 核实依据：`ds-bot/src/host/channel.js:98` 的 `READS` 集合只含 `account-state`，不含三个变更端点；`channel.js:143-144` 对不在集合内的端点统一 `bot/read-only` 拒绝；四端点定义在 `channel.js:183-190`，实现转发 `ds-bot/src/host/account.js:57-65`。
- 修法：在既有用例「a host that only reads the team still answers the account state, but changes nothing」内，按 `account-sign-in` 断言的同款写法补两行（`account-cancel` 与 `account-sign-out` 各断言 `[ok, error.code] === [false, 'bot/read-only']`）。
- 验证（本会话实跑，仓库根执行）：

  ```
  node --import "data:text/javascript,process.chdir('ds-bot')" --import ./ds-bot/test/harness-resolve.mjs --test ds-bot/test/account-channel.test.js
  ```

  输出：`tests 7 / pass 7 / fail 0 / skipped 0`（duration_ms 346.2），含扩展后的只读宿主用例。这是单文件定向跑，不是全量 `npm test`。

## d) 阻塞项 runbook（前置 + 精确命令）

### d-1 smoke（dev/bench.sh 台架）

- 前置：
  - deepseek-harness checkout：`ds-bot/README.md:231` 要求放在 `../deepseek-harness` 或以 `DSH_HARNESS` 指定；版本 `0.2.1-rc.2`（`ds-bot/README.md:7`，与 `ds-bot/dev/harness/package.json` 的 `@deepseek-ai/dsh` 一致）。`dev/bench.sh:25-32` 的解析顺序：环境变量 `DSH_HARNESS` → 仓库根 `deepseek-harness` → 主工作树相对路径 → 主仓库根。
  - POSIX `sh` 与 `setsid`（`bench.sh:34-49` 用 setsid 进程组启停进程）。
  - pnpm 在 PATH：`bench.sh:64` 建 web profile 用 `pnpm install`、`bench.sh:103` 起 web 进程用 `pnpm -s dsh`；`ds-bot/README.md:231` 明列 Node 24 + pnpm。本机 pnpm 在 PATH（实测可执行），非阻塞。
- 本机现状（2026-10-27 实测）：`../deepseek-harness`（即 `Desktop\deepseek-harness`）不存在；仓库根 `deepseek-harness` 不存在；`ds-bot/deepseek-harness` 不存在；`DSH_HARNESS` 未设置；`command -v setsid` 无结果——`setsid` 在本机 Windows Git Bash 缺失，属平台性阻塞（与决策日志 2026-10-23 C0 盘点「bench.sh 本机 Windows 不可执行」一致，ROADMAP L135）。
- 命令（bench 起后跑 smoke；端口各留空闲）：

  ```sh
  CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096
  dev/bench.sh smoke 3096 8796 stop   # 结束后
  ```

- 补齐方式：在能跑 POSIX 环境处（WSL / Linux / macOS）放好 deepseek-harness checkout（装依赖）并设 `DSH_HARNESS`，再执行上述命令；或按 C0 计划交付 Windows 可执行入口（判据出处：解耦设计 L110「C0 必须交付：Windows / CI 可执行入口」；本机 Windows 不可执行的盘点记录见 ROADMAP L135）。

### d-2 真机取证（桌面 app 实机 OAuth 登录 + 两形态回归）——待用户

- 前置：桌面 app 可启动（`app/` 下 `npm start`）；开发态需先把 `index.js / client.js / src/host` 同步到 `app/node_modules/miasaki-dsbot`（真机验证约束，决策日志 2026-10-25，ROADMAP L148；正式安装不受影响）。
- 步骤：① own UI 形态走 Models 页 AccountRow Sign in → DeepSeek OAuth 浏览器授权 → 对话框轮询自动关闭 → Signed in.；登出两次确认 → Signed out；逐屏截图（补 §b B-4/B-5 的真机档）。② `DS_BOT_OWN_UI=0` 回归 DSH 前端形态，确认登录入口与团队功能不受影响（回滚窗口此前的真机记录见 ROADMAP L149）。
- 判据：截图链路完整、无黑屏 / 遮挡（z-index 修复后的真实渲染）。

### d-3 npm Trusted Publishing——待用户在 npmjs.com 配置

- 前置：npmjs.com 账号对包名 `miasaki-dsbot` 的管理权。
- 配置项（决策日志 2026-10-25 六项收尾交底，ROADMAP L151；机制依据解耦设计 L143 与 ROADMAP L138）：Trusted Publisher → GitHub Actions；repository `Miasakiii/DeepSeek-Bot`；workflow `release.yml`；environment 留空。
- 未配的后果：OIDC 发布直接失败（ROADMAP L138）。

### d-4 阶段 A 真实自托管端点端到端（LM Studio 127.0.0.1:1234）——待用户

- 前置：LM Studio（或任一 OpenAI 兼容自托管端点）在本机起服务，监听 `127.0.0.1:1234`，至少载入一个可对话模型（若要验读图，载入带视觉的模型）。
- 步骤（判据 = 解耦设计 L73）：app 或插件形态新建 provider（协议 `openai-completions`，baseURL 指向该端点；mock/适配器对 baseURL 带不带 `/v1` 均容忍，ROADMAP L144）→ 发现模型（GET `{baseURL}/models`）→ 在界面选中它的模型 → Bot 完成一轮 → 读图 / 记忆整理走通 → 全程确认不写 DSH 设置（provider 落自有 `state.providers` 与 `home/keys.json`）。
- 注意：这是验收缺口，不是代码缺口——代码/测试侧已证（§a A-1/A-3）。

### d-5 Linux/macOS `dev/check.sh`——本机不可跑

- 前置：一台 Linux 或 macOS 环境（`ds-bot/README.md:231`：Node 24、pnpm、`../deepseek-harness`；Desktop 台架还需 `xvfb-run` 与 `ffmpeg`，截图需 Chrome/Chromium）。
- 命令：合入前在该环境跑 `dev/check.sh`（合入前阻塞项；记录见 ROADMAP L143「2026-10-24 阶段 A 第四切片」与 L151 剩余清单「Linux/macOS `dev/check.sh` 本机不可跑」）。
- 本机现状：Windows，不可跑；本会话未尝试、无输出。

## e) PR #1 CI 状态与结论

- 本会话执行（仅一次，按口径不重试）：

  ```
  HTTPS_PROXY=http://127.0.0.1:1088 HTTP_PROXY=http://127.0.0.1:1088 gh pr checks 1 --repo Miasakiii/DeepSeek-Bot
  ```

- 输出：`Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:1088: connectex: No connection could be made because the target machine actively refused it.`
- 结论：**本机不可达**——本地代理 `127.0.0.1:1088` 拒绝连接，不是 CI 失败，也未取得任何 CI 状态数据。CI 真实状态以 GitHub 网页为准，或代理恢复后再查。最近一条已落档的相关记录：决策日志 2026-10-25 修复 `test.yml` result job 对已删除 app-package* job 的引用（PR #1 当时的唯一红灯，ROADMAP L151）；其后无新记录。

## f) 质量门

工作流质量门实测（2026-10-27，由工作流执行并回填；本会话未复跑）：

| 门 | 结果 |
|---|---|
| ds-bot 全量单测 | exit 0（通过；TAP 汇总行未能解析出具体例数，以退出码为准——本次运行不带 1133/1132/1 这类逐例计数，最近一次带计数的全量记录仍是决策日志 2026-10-26，ROADMAP L152） |
| client `--check` | exit 0（`client.js` 与 `src/client/` 一致） |
| lint | exit 0（0 错误） |

说明：本次质量门输出只有上述三门；app 侧单测与 UI 构建不在本次输出中，其最近记录仍是决策日志 2026-10-26 的 app 99/99 与 UI 构建通过（ROADMAP L152）。

## 修订记录

- 2026-10-27 复核修订：按独立复核意见逐条核处后改五处——A-4 剩余栏与 §f 对齐为「三门已补跑，app 单测与 UI 构建不在输出中」（原「全量五门」与 §f 自相矛盾）；B-4 状态改为「部分真机已证」，「设置」「Bot 详情」两项按证据口径改标「无记录、待补」（ROADMAP L149 场景清单无此二项）；d-1 前置补 pnpm（`bench.sh:64` `pnpm install`、`:103` `pnpm -s dsh`、`ds-bot/README.md:231`，本机 pnpm 在 PATH）；d-1 的 C0 出口改引解耦设计 L110（原误引 ROADMAP L110，该行实为 §六硬规则第 6 条）；d-5 的剩余清单改引 ROADMAP L151（L152 为 z-index 修复条目，不含 check.sh）；另在开头补工作区在先改动的显式 add 提醒。两条意见驳回：①「本机 npm 不可用」前提——本文无任何断言依赖该前提（§c 定向命令用 node 直跑、d-2 本就写 `npm start` 可行），实测本机 npm 11.12.1 在 PATH，无文可改；②§f ds-bot 全量门「未经复核实跑」——§f 表头已标「由工作流执行并回填；本会话未复跑」，出处披露即口径本身，按任务要求照实记录工作流回传结果，无需改文。

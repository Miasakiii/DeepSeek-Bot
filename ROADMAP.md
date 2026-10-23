# DS Bot Fork 总体规划

> 本文件是 fork 的唯一规划入口，后续决策追加到文末「决策日志」。
> 上游调研报告（架构/协作机制/记忆安全/UI/工程实践/与 miasaki 对照）在 miasaki 仓：`_refs/DeepSeek-Bot-research-report.md`。
> **解耦主线（2026-10-22 拍板）总设计在 [`docs/plans/2026-10-22-decouple-from-dsh.md`](docs/plans/2026-10-22-decouple-from-dsh.md)，§四 阶段计划已按其改版；涉及解耦的决策以该文档为准。**
> **2026-10-23 评审修订 + 六项决策已拍板**：解耦主线定为 **A → B1 → C0 → C → B2 → D**（原 B 拆成「去前端」B1 与「去宿主」B2，C 前插 C0）。已拍板细节（B1 保留 Host 子进程；账号 B1 沿用 DSH 账号服务、C0 评估 / C 自研 OAuth；发布身份改 fork 自有 appId 与更新源；插件生态 MCP 保留 / skill 自有 / 引擎与界面插件终止；C0 关键路径 6-8 周）见解耦文档「已定决策」。**C0 依赖清单已完成**（[`docs/dev/c0-dsh-dependency-inventory.md`](docs/dev/c0-dsh-dependency-inventory.md)）。本文件 §四 已按此更新。

## 一、定位决策（2026-10-22 拍板）

**把它做成一个独立的软件，路线 A：fork 上游 Electron app 作为独立软件基础。**

- 上游 0.2.0 已交付「自带锁定版 DSH（0.2.1-rc.2）+ 独立 profile + 独立数据目录」的桌面 app（Windows exe / macOS zip，自动更新、Win11 Mica、只装当前用户）——「独立软件」最难的基建（安装器、更新、签名 CI）上游已模板化，fork 直接站在成品上
- 壳（Electron 主进程 + profile-boot 三 bundle）基本不动；**全部定制集中在 `ds-bot/`**
- 桌宠融合列为第二阶段诱饵：上游默认 Main Bot 就是「a whale in DeepSeek blue」，与 miasaki 桌宠 whale 帧同源；等上游 `app/ui`（React 自绘界面，目前 On hold）推进后接桌宠状态层顺水推舟，现在硬融要在 DSH 网页前端里塞 Win32 原生层，上游自己都特意没这么做
- 本地位置：`C:\Users\Asakii\Desktop\miasaki-dsbot\`（monorepo 外，git 独立）

> **2026-10-22 修正**：路线 A 的隐含前提「长期吃到上游 1.2 天/版的 merge 红利」在解耦阶段 C（自有 Agent 循环）完成后**不再成立**——届时与上游代码脱钩，只借鉴 `docs/plans` 的设计。阶段 A 期间 merge 红利照常；B1 起 `app/` 不再同步上游（见 §五）。

## 二、仓库与远程

| Remote | 地址 | 用途 |
|---|---|---|
| origin | https://github.com/Miasakiii/DeepSeek-Bot.git | 自己的 fork（推送） |
| upstream | https://github.com/Fei2411/DeepSeek-Bot.git | 上游（拉取跟进） |

**分支策略**：上游 `dev` 是集成分支、`main` 只发版。日常基于 `main`（稳定）；需要新特性时 `git fetch upstream && git merge upstream/dev`，merge 后必须全测试。自己的改动走 `feat/<issue>-<name>` / `fix/<issue>-<name>` 分支，PR 进 `dev`（继承上游流程，便于回哺上游）。

## 三、环境基线（2026-10-22 已建立）

- Node v24.15.0 / pnpm 11.22.0 / gh 已登录 Miasakiii
- `npm ci` ✓（esbuild 0.28.2）
- `npm run harness` ✓（651 包，DSH 0.2.1-rc.2，装在 `ds-bot/dev/harness/`）
- **`npm test` ✓ 基线：836 例、835 通过、0 失败、1 跳过**（跳过项 = 「Windows drops trailing spaces from names」平台特性用例；5-7 秒跑完，2026-10-23 复测 6.3s；改名前基线 832，home-move.test.js 迁移用例 +4）
- 常用命令（均在 `ds-bot/` 下跑）：

```sh
npm test                                  # 93 个测试文件（Node 内置 runner）
node scripts/build-client.mjs --check     # client.js 与 src/client 同步
npm run lint                              # oxlint
dev/bench.sh <name> <webport> <mockport> start   # Web 测试台（mock 模型，零 token）
dev/check.sh                              # 全套：unit/build/lint/smoke/web/desktop
```

## 四、阶段计划

### 阶段 0：测试基线（✅ 2026-10-22 完成）
原版 fork 全绿，作为后续每次改动的参照。判据：`npm test` 全过 + `--check` 过 + lint 过。
**实测：832 例 / 831 通过 / 0 失败 / 1 跳过（Windows 平台特性），5.0s。**

### 阶段 1：改名（✅ 2026-10-23 完成代码面 + 文档 / 发布面收尾，2026-10-24 提交于 `chore/rename-miasaki-dsbot`；仅剩 npm Trusted Publishing 运营配置）
不改则两个版本不能装同一个 DSH profile、会抢 `~/.dsh/bot/` 数据目录（state.lock 单写者）。实际改动清单：
- **插件身份**：`package.json` name → `miasaki-dsbot`；`index.js` name 导出同步；`cordis.patch.yml` 插件 id `bot`→`miasaki-bot`、`web-search-auto`→`miasaki-web-search`；client bundle id → `miasaki-dsbot`（build-client.mjs + 重新 build）
- **数据目录**：`$DSH_HOME/bot/` → `$DSH_HOME/miasaki-dsbot/`（index.js home）；测试与 dev 工具 8 处跟随
- **app 侧**：profile 名与 bundle 名 → `miasaki-dsbot`；默认数据目录 `~/.ds-bot` → `~/.miasaki-dsbot`；依赖名与 lock 同步；import 目标侧统一新目录
- **import 源/目标分离**（关键设计）：源侧探测 `miasaki-dsbot` 优先、回落 `bot`——上游 ds-bot 用户建的团队仍能导入（README 承诺的迁移路径）；import.test.mjs 的源 fixture 刻意保持 `bot/`，正好钉死这条兼容路径
- **发布链**：Dockerfile npm pack 产物名、release.yml tgz 名、test.yml 卸载断言的数据目录同步
- **验证**：`npm test` 832 例 / 831 通过 / 0 失败 / 1 跳过（与基线一致）；`build --check` 过；lint 0 错误（11 warnings 全部位于未改动文件，上游存量）；app 侧 `npm test` **75/75 全绿**；契约测试抓漏 3 处即修（constants.test.js name 断言、import.mjs move-in 阶段、profile.test.mjs id 断言）；改名收尾加入 home-move.test.js（4 例）后为 836 例 / 835 通过 / 1 跳过
- **2026-10-23 收尾完成；2026-10-24 提交于 `chore/rename-miasaki-dsbot` 分支**：① `CHANGELOG.md` Unreleased 补改名条目（含 appId 断代的卸载重装说明）；② README / README.zh / known-issues 中英 / release-checklist / docker README 的包名、插件 id（`miasaki-bot`）、数据目录（`miasaki-dsbot/`）与 Releases 链接改到 fork；③ `app/src/updates.mjs`、`electron-builder.yml` 的更新源 / publish owner 改到 fork；④ 发布身份落地：appId → `io.github.miasakiii.dsbot`，`app/package.json` author 与 NOTICE 版权同步（更新断代已写进 CHANGELOG 与 desktop-app 设计「变更」）；⑤ `ds-bot/package.json` 的 repository / homepage / bugs 与插件自更新源改到 fork（update / dsh-update 测试跟随）；⑥ **旧数据目录迁移**：`index.js` 首次启动把 `bot/` 迁到 `miasaki-dsbot/`——另一个 dsh 正占用该团队时改用自有新目录，`config.home` 自定义时不动（`test/home-move.test.js` 4 例）；顺带修掉两处改名漏网：`app/src/first-run.mjs` 的 `hasTeam`（读自己数据位置里的团队目录）与 `app/src/host.mjs` 注释。
- **唯一剩余（运营步骤，代码外）**：在 npmjs.com 给包名 `miasaki-dsbot` 配 Trusted Publisher（user Miasakiii / repo DeepSeek-Bot / workflow release.yml / 无 environment），否则 OIDC 发布直接失败。需用户在 npm 网站操作，仓库内无法代劳；release.yml 头部注释已按新包名写好步骤。

### 解耦主线（2026-10-22 拍板；2026-10-23 评审修订并拍板 A→B1→C0→C→B2→D）

> 总设计（每阶段的行为、验收、不做什么、风险）：[`docs/plans/2026-10-22-decouple-from-dsh.md`](docs/plans/2026-10-22-decouple-from-dsh.md)；C0 依赖清单：[`docs/dev/c0-dsh-dependency-inventory.md`](docs/dev/c0-dsh-dependency-inventory.md)。各阶段独立可发布；「独立软件」正式发布受解耦文档「独立化前置」的实施进度阻塞（账号与发布身份已拍板，数据迁移 / 发布链 / 插件生态按阶段实施）。

- **阶段 A：自有 LLM 层（2-4 周）**——provider 目录、密钥库（`home/keys.json`）、三协议客户端（openai-completions / openai-responses / anthropic-messages）进自有 state.json；经文档化插件 API `ctx.llm.registerAdapter` 注册自有适配器（不打补丁）；turn 循环仍由 DSH 执行。**收益：多厂商 + 自定义模型（自托管端点走 openai-completions）**，但须补「Models 页在插件形态可见」的客户端接线，收益才兑现；迁移须防 `DUPLICATE_ADAPTER`（同名 provider 双注册）。
  - 产物：`src/host/llm.js`、密钥库、三协议客户端、迁移 fixture、扩展后的 `dev/mock-llm.mjs`。
  - 验收：三协议 mock 单测全绿 + 真实自托管端点端到端 + 迁移不撞名 + 836 例 / `--check` / lint 全绿 + 账号路由回归。
- **阶段 B1：自有前端与自有出口（4-8 周）**——原「阶段 B」的低风险部分：`channel.js` 抽出 transport 层后自起 `node:http`（`api/bot` + SSE feed + 静态文件）；启用 `app/ui`（现为 On hold 原型，需功能对齐、打包、登录入口，以及**浏览器壳桥**——`read_browser` 依赖 DSH Desktop 壳的 Electron webview 租约，自有 app 未提供）；app profile 去掉 `dsh-web-app`；配置迁移（旋钮实测 **29 处 / 19 键**）。**turn 仍由 DSH 执行，DSH Host 保留**——B1 的验收不是「无 DSH 进程」。
  - 运行时形态（已拍板）：保留独立 Host 子进程（现结构，只换入口）；内嵌 DSH 库与「自有 server 跑在 DSH Host 内」不采用。
  - 产物：自有 HTTP server、启用后的 `app/ui` 安装包、去 `dsh-web-app` 的 profile、回滚开关。
  - 验收：窗口 origin 是自有 server + profile 无 `dsh-web-app` + 自有 UI 里 turn 端到端跑通 + 群聊/详情/设置/搜索/审批截图对比 + **账号登录在自有 UI 可用**（保留 DSH 账号服务） + 插件形态不受影响 + 可一键回退到 DSH 网页前端。
- **阶段 C0：可执行性前置（已拍板关键路径 6-8 周，C 的 gating）**——**依赖清单已完成**：[`docs/dev/c0-dsh-dependency-inventory.md`](docs/dev/c0-dsh-dependency-inventory.md)（服务 19 / 事件 14 = 11 核心 + 3 可选 / 工具实体 26 / 测试分层 / 数据格式）。其余产物：零语义薄替代（`createUserMessage`/`BlockAssembler`/`defineTool`/`WebError`，39/92 测试文件 import 阶段依赖 DSH 包）、`rt.host` 契约层（含 Agent/Session 对象面、中间件顺序、effect lifecycle）、`fake-host` 契约测试、双跑 golden master（基线 + `dev/golden-diff.mjs` + Windows/CI 入口；现状无基线、无 diff 工具、CI 不跑 smoke）、数据迁移与崩溃设计（DSH 会话 v4 迁移链会改事件序号，需冻结「id 不变 + seq 单调度量」）。数据面 version 链与 JSONL fixture 降为 C2 前置；双跑场景先做审批 + 压缩。**没有 C0，C 的「3-6 个月」不成立。**
  - 验收：依赖清单评审通过 + 零语义薄替代让 import 依赖文件脱离 DSH 包 + 836 例在 fake-host 上全绿 + 双跑脚本一键出差异报告。
- **阶段 C：自有 Agent 循环（6-12 个月，风险最高）**——循环本体、会话存储（含 DSH 会话迁移与格式版本链）、工具面（文件/Shell/浏览器 + 后台 jobs + `working_directory` + `restrict`/`guard`/审批/超时/截断/spill/并发分类 + 工具流水线与 `concludeTurn`/PTC 等价事件）、MCP/skill/连接器生态替代（MCP 中立 SDK 薄桥 / skill 自有 / DSH 引擎与界面插件终止）、上下文管家、用量全部自有；**至此与上游代码脱钩，只借鉴设计**；上游已知软肋（群轮次状态纯内存崩溃丢本轮、下游等待无超时、防泄漏列举式闸）顺带解决（加范围不加工期）；测试 = C0 契约层上的渐进迁移 + 双跑差异=0。
  - 验收：双跑差异=0 的场景数覆盖群聊/派活/记忆/审批/压缩/迟到回复，以及工具面（取消、审批超时、spill 恢复、restrict 时机、长结果截断）；审批/重试/中止/压缩/用量与 DSH 对齐；崩溃恢复演练通过。
- **阶段 B2：去 DSH 宿主（1-2 月，排在 C 之后）**——自有引擎入口替换 `runProfile`、插件装配脱离 cordis profile、安装器与自动更新链自建、DSH 从安装包消失。
  - 验收：进程树无 DSH Host + 真实安装包冷启动/升级/回滚 + 发布链（含 npm Trusted Publishing）可用。
- **阶段 D：移动端（1-2 月）**——D0 先用现有 web 形态 + 局域网出口做手机可行性验证；Capacitor 打包 `app/ui` 线 SPA + 响应式改造；**明确 thin client 限制**（手机连桌面后端、同可信网络、桌面休眠不可用）；安全模型（配对码 / 短时吊销 token / TLS 或 SSH 隧道 / CORS / ATS / cleartext）；真机 iOS/Android 验收；不做后台推送。

> **顺序说明**：原 A→B→C→D 在「B 同时去前端与去运行时」时自相矛盾（turn 到 C 才离开 DSH，B 却要求 DSH 进程消失）。拆分后 B1 去前端、B2 去宿主，C 才是真正脱钩点。**2026-10-23 已拍板采用 A→B1→C0→C→B2→D**，不再保留原顺序。已定决策见解耦文档。

### 并行轨道（不受解耦主线阻塞，随时可做）

- **配置层盘点（原阶段 2，兼 B1-4 迁移输入）**：插件配置面（`rt.config`，可被 DSH profile patch 的 config 覆盖或 app 配置注入）已暴露的旋钮，**2026-10-23 实测为 29 处读取 / 19 个键**（原记「13 处」不准确）。除原先 11 个键外还包括 `mainName` / `mainRole`、`textOnlyModels` / `ocrModel`、`timeZone`、`handoffRecentTokens` / `handoffListTokens`、`timeRefreshIntervalMs`。两个用途：
  1. **定制前的决策辅助**：四项定制（UI / fleet 接入 / 逻辑 / 功能）逐条对到「配置即可满足 / 必须改码」，不急着改码；
  2. **B1 的迁移清单**：这些旋钮现全部挂在 DSH 的 profile/patch 机制上（`cordis.patch.yml` 即 DSH 装配格式），B1 起配置源要迁到 DS Bot 自己的配置文件——本盘点的产出就是 B1 的输入，避免迁移时漏项。
- **UI/外观（原阶段 3）**：基础设施现成：`--bt-*` 令牌体系 + `style-debt.json` 计数台账（新增即失败、只降不增）+ `motion.js` 弹簧动效。改造入口 `src/client/styles.js`。调研报告（miasaki 仓 `_refs/DeepSeek-Bot-research-report.md` §6.5/§9.6）的增量结论：
  - **值得借鉴**：① 可逆整机皮肤化（slot shadow 优先级 -100 永压官方之下 + 双组原子安装回滚 + plain 子态）；② host/client 共享纯函数校验 + 带修复建议的拒绝信息（show_view 已验证的范式）。
  - **脆弱点（改造前必读）**：① client 的 800+ 行 CSS 大量耦合官方壳**未文档化 DOM**（`[class*="_scroll"]`、`[data-step-process]` 等子串选择器），DSH 升级可能整片失效——与解耦主线强相关：阶段 C 自有前端后此耦合消失，C 之前每次跟上游升级都有皮肤失效风险，改 UI 时优先收敛这类选择器；② style-debt 存量未清（styles.js 一家登记 20+ 颜色、11 种 radii）且扫描器有整文件豁免盲区；③ 轮询密度（roster 1.5s + GroupReplies 1s）靠纪律无机制；④ i18n 正则翻译表对 host 措辞变更零容错。
  - **风格纪律口径（§9.6 结论）**：不推翻 miasaki「一律用官方 primitives」的用户规矩，但移植 style-debt「只降不增」台账，给存量违规一条可见的清偿路径。
  - 桌宠融合同列为诱饵，等 C 后自有前端更自由。
- **fleet CLI 接入（原阶段 4）**：上游 vision 第 10 条「接入本地 Agent CLI」仍是 planned，无设计文档——战略价值最高，但自有循环（C）落地后「把外部 CLI 包成 Bot 会话外壳」更自然。动手前写自己的 `docs/plans/<date>-<topic>.md`。
- **发布链（原阶段 6；2026-10-23 提前为 B1 前置）**：B1 起 app 逐步脱离上游 `release.yml` 模板，安装/更新链需自建；npm Trusted Publishing 必须先在 npmjs.com 给 `miasaki-dsbot` 配好（否则 OIDC 发布失败）。发布身份已落地：appId 改 `io.github.miasakiii.dsbot`、publish owner 与更新源改 fork、NOTICE 与作者信息同步（签名、商标）见解耦文档「独立化前置」，独立发布前 blocking。

## 五、上游跟进纪律

1. 每次跟进：`git fetch upstream` → 看 diff 规模 → merge 到工作分支 → `npm test` + `--check` + `lint` 全绿才算跟进完成
2. 冲突高发区预判：`ds-bot/client.js`（生成物，禁手改——在 src/client 解冲突后 `npm run build` 重生成）、`state.json` 迁移链（store.js）、CHANGELOG.md（上游 PR 不写它，冲突时保留两边）
3. 自己的改动保持小提交、一个 PR 一件事（上游规矩，也是减少冲突的最好策略）
4. 上游节奏口径（2026-10-23 修正）：历史均值约 1.2 天/版，但最近一版间隔 4.66 天；实际跟进成本由 dev 提交量驱动——上游 dev 约 2.2 天累积 100 提交，fork main 落后约 100 提交。建议每周跟进一次，间隔太久迁移链冲突会滚大。
5. **冻结策略（2026-10-23）**：C 动工前做最后一次 `upstream/dev` merge，只取 `ds-bot/` 与 `docs/plans/`（`app/` 从 B1 起不再同步）；C 期间只 cherry-pick 安全 / 数据损坏修复，不跟新特性；B1 之后放弃上游 `app/` 代码同步，只保留 `ds-bot/`；C 完成后与上游代码脱钩，只借鉴 `docs/plans` 设计。
6. **跟进时间计入资源预算**：每周 1-2 天，不能按「顺手做」估。

## 六、继承自上游的硬规则（fork 里可改，建议先遵守）

1. `client.js` 是生成物，禁手改；改 `src/client/` 后 `npm run build` 并提交两者
2. 改 `index.js` 或 `src/host/` 必跑 smoke（`dev/smoke.mjs`）
3. 测试数据绝不指向 `~/.dsh`（bench 用 `.dsh-test-<name>/`）
4. commit author 必须是人，不加 AI Co-authored-by
5. 不留兜底上限、治理靠结构不靠配额（上游 design 哲学）
6. 用户可见文案默认英文，中英 README 同步（如要改中文优先，在此条决策日志记一笔再动）

## 七、决策日志

- 2026-10-22：路线 A 拍板（fork 上游 app 做独立软件，壳不动、定制集中 ds-bot/）。四项定制（UI/fleet 接入/逻辑/功能）全部纳入；排期见 §四「并行轨道」（2026-10-23 解耦主线改版后，原「顺序见 §四」不再指四项定制的顺序）。
- 2026-10-22：仓库落桌面独立文件夹 `Desktop\miasaki-dsbot\`（原记录误写 dsh-dsbot，实际以本路径为准），不进 miasaki monorepo。
- 2026-10-22：**包名 `miasaki-dsbot`**；插件 id `miasaki-bot`；数据目录 `~/.dsh/miasaki-dsbot/`；app profile 名与默认数据目录 `~/.miasaki-dsbot` 同步（见 §四 阶段 1）。
- 2026-10-22：**暂不改的四类**（零功能影响，改则 250+ 处 diff 稀释上游 merge 红利，均记此处待后续决策）：
  1. 日志前缀 `ds-bot: `（install.test.js 钉死 30+ 条断言，改要同步）
  2. 产品名「DS Bot」用户可见文案（品牌决策，归 UI 轨道、B1 启用自有 UI 时定）
  3. app 壳 IPC 通道 `ds-bot:*` 与 `window.dsBotApp`（私有协议无冲突，client 侧有引用）
  4. docker 镜像 tag `ds-bot:local/test`（纯本地命名）
- 2026-10-22：**import 源/目标分离**——从用户 DSH 导入时源目录探测 `miasaki-dsbot` 优先、回落上游 `bot/`，上游版用户的团队可平滑迁移。
- 2026-10-22（晚）：**解耦主线拍板，顺序 A→B→C→D**（自有 LLM 层 → 自有宿主 → 自有 Agent 循环 → 移动端）。依据为全仓耦合实测：客户端已独立（app 窗口只走 api/bot，DSH primitives 已被自研组件替换；2026-10-23 复核：该判断对 app/ui 原型成立，现装窗口仍是 DSH 网页前端）；绑在 DSH 的仅四块基底（循环 / LLM / 工具 / 宿主生态）。关键使能点：DSH 文档化了 `ctx.llm.registerAdapter(providers, adapter)`，阶段 A 可走公开 API 实现自有适配器。总设计：`docs/plans/2026-10-22-decouple-from-dsh.md`。
- 2026-10-22（晚）：**移动端定 Capacitor**（复用 app/ui 线 SPA + 响应式；不选 PWA——无推送、iOS 限制多；不选 RN/Flutter——重写成本高）。
- 2026-10-22（晚）：**测试策略定「兼容垫层 + 渐进重写」**——阶段 C 不给 832 例做大爆炸重写，先以内部缝让测试跑在自有基底上，逐批迁移（2026-10-23：seam 已存在于 `test/fake-ctx.js` 与内联 fake，但未抽层，改由 C0 抽 `rt.host` 契约层与 `fake-host`）。
- 2026-10-22（晚）：**解耦后与上游的关系**：阶段 C 完成起代码脱钩，只借鉴 `docs/plans` 设计（上游同格式）；阶段 A/B1 期间 merge 红利照常。
- 2026-10-22（晚）：**原阶段 2（收割配置层）恢复为并行轨道**（改版解耦主线时一度漏掉，现补回）。原记录称旋钮「cordis.patch.yml 已暴露」不准确：旋钮实为插件 `config.*` 面（2026-10-23 复核为 29 处读取 / 19 个键），cordis.patch.yml 只负责挂插件；且因 cordis.patch.yml 本身是 DSH 装配格式，该盘点的产出同时是 B1 配置迁移的输入清单。
- 2026-10-23：**评审后修订解耦主线**（三路只读评审 + 事实核验；832 例实测 6.3s；`registerAdapter` 的公开性经类型定义 / 包 README / 官方自用三方确认）。要点：
  1. 原 B 同时承担「去 DSH 网页前端」与「去 DSH 运行时」，与「turn 到 C 才离开 DSH」矛盾；拆成 **B1（自有前端 + 自有出口，DSH Host 保留，4-8 周）** 与 **B2（去 DSH 宿主，排 C 后，1-2 月）**，顺序改为 A→B1→C0→C→B2→D（2026-10-23 已拍板）。
  2. C 前插 **C0**（依赖清单 / `rt.host` 契约层 / fake-host 契约测试 / 双跑 golden master / 数据与崩溃设计；2026-10-23 C0 盘点后估时由 ≤4-6 周上调为 **6-10 周，关键路径 6-8 周**）；C 由 3-6 月重估为 **6-12 个月**，验收改为「双跑差异=0 + 可靠性对等」。
  3. 新增「独立化前置」：账号 OAuth（A 不重写；2026-10-23 已拍板 B1 沿用 DSH 账号服务、C 自研）、DSH 会话数据迁移、发布身份（appId/owner/更新源/签名/商标；已拍板改 fork 自有）、插件生态去留（已拍板三档）——列为独立发布 blocking。
  4. 事实修正：`app/ui` 是 On hold 原型、现装窗口仍是 DSH 网页前端；配置旋钮 29 处 / 19 键（原 13 处）；Bot 工具 17/25/26 口径（原 15）；上游最近一版间隔 4.66 天、dev 2.2 天 100 提交；`channel.handle()` 未导出且依赖 DSH 服务；StreamChunk 词表以 `block-start/text-delta/…` 为准。
  5. 配套规则：AGENTS.md 与 CONTRIBUTING 中英硬规则改为「阶段 C 前基于 DSH、C 起自有运行时，任何阶段不打补丁」；docs/plans/README 补目录与 ROADMAP 指向。
  6. 数据目录改名收尾未完成：`~/.dsh/bot/` → `miasaki-dsbot` 无回落/迁移；README/CHANGELOG/known-issues/release-checklist/更新源仍指旧包名与上游。阶段 1 状态改为「代码面完成、文档/发布面待收尾」。
- 2026-10-23（C0 盘点）：**DSH 依赖清单完成**，[`docs/dev/c0-dsh-dependency-inventory.md`](docs/dev/c0-dsh-dependency-inventory.md)。要点：`ctx.get` 19 服务 / 35 次（原记 17）、事件 14 名（11 核心 + 3 可选）、工具实体 26（`ctx.tools` 30 是调用数）、`ctx.effect` 26、`ctx.plugin` 3 挂载、测试 39/92 文件 import 阶段依赖 DSH 包、DSH 会话格式 v4（v0→v4 迁移链，v1→v2/v2→v3 改事件序号）、双跑资产无基线/无 diff 工具/Windows 不可执行。据此：**C0 估时 6-10 周（关键路径 6-8 周）**；浏览器桥实为 Electron 壳 webview 租约（非 CDP），B1 需自建壳桥；生态口径定为 MCP 保留（中立 SDK 薄桥）/ skill 自有实现 / DSH 引擎与界面插件终止；C3 工具面补 jobs、working_directory、spill、并发语义与工具流水线。
- 2026-10-23（决策拍板，用户确认「待拍板事项都按建议规划设计，先不写代码」）：**六项已定**——①顺序 A→B1→C0→C→B2→D；②B1 保留 Host 子进程；③账号 B1 沿用 DSH 账号服务 + 自有 UI 复刻登录，C0 评估 / C 自研 OAuth（保底 API key 迁移）；④发布身份 appId → `io.github.miasakiii.dsbot`、owner / 更新源 → fork、接受首次独立发布更新断代（用户卸载重装）；⑤插件生态 MCP 保留 / skill 自有 / 引擎与界面插件终止；⑥C0 关键路径 6-8 周。本轮只更新规划文档，不动代码。
- 2026-10-23（改名收尾实施）：完成阶段 1 的文档 / 发布面收尾与发布身份落地（清单见 §四 阶段 1）。实现决策：旧数据目录用**一次性迁移**（`bot/` → `miasaki-dsbot/`，启动时、读状态前）而非读取回落——两个插件可同 profile 共存（插件 id 不同），读取回落会让双方共写一个 `state.json`；迁移前检查 `state.lock`，另一个 dsh 正用时本插件起自有新目录，`config.home` 自定义时不动。npm Trusted Publishing 是唯一剩余项，属 npmjs.com 上的运营操作。
- **运营待办（发布前必须；2026-10-23 提前为 B1 前置）**：npm Trusted Publishing 按包名配置——上游 release.yml 注释明确「package ds-bot → Settings → Trusted Publisher → GitHub Actions」，fork 包名改为 `miasaki-dsbot` 后，必须先在 npmjs.com 给新包名配好 Trusted Publisher，否则 OIDC 发布直接失败。
- 2026-10-24（阶段 1 落库）：改名收尾与规划文档提交至 `chore/rename-miasaki-dsbot`（NOTICE 改为与上游并列署名——Apache-2.0 §4(c) 要求保留上游版权行；测试口径复核 836/835/1、93 个测试文件、40/93 文件 import 阶段依赖 DSH）。npm Trusted Publishing 仍待用户在 npmjs.com 配置。

# C0 账号评估：自研 OAuth / token 服务 vs 保底路径

- 日期：2026-10-30
- 相关：[解耦设计](../plans/2026-10-22-decouple-from-dsh.md) §「独立化前置·账号」（:140）与「已定决策」第 3 条（:202）；[dsh-go borrowings 与编排](../plans/2026-10-30-dsh-go-borrowings-and-orchestration.md) §3.4b（S4b，:222-232）、§二 A-03/A-04（:93-94）、§3.7 进 C1 门槛（:287）；[C0 执行基线](2026-10-27-c0-execution-baseline.md)（下文简称 c0-execution-baseline.md）；[ROADMAP §七 决策日志](../../ROADMAP.md) 2026-10-25 B1 登录切片条目（:151）
- 性质：本文是 S4b 的指定产物（orchestration:222-224：解耦设计 decouple:140 要求而 C0 执行基线漏收的 C0 设计产物），作为 C 的 gating 输入。**只读盘点，不改任何代码**：所有现状断言给 file:line，未验证的明记「未验证」。结论是二选一的建议与触发条件，不是新设计；与已定决策冲突之处不改决策，只如实呈现成本证据。

## 一、现状：B1 沿用 DSH 账号服务的接线全貌

账号能力由 DSH `dsh-base` profile 里的三个包提供，插件侧只做调用与转发。拍板口径：decouple:140（B1 保留 DSH 账号服务、C0 评估、C 阶段自研；保底 = 弃用账号登录 + API key 迁移引导）与 decouple:202（已定决策 3）。

### 1.1 服务来源（DSH 侧，非我方代码）

- 抽象服务 `DeepSeekAccount`：`@deepseek-ai/dsh-deepseek-account`（MIT，版本 0.2.1-rc.2，`ds-bot/dev/harness/node_modules/@deepseek-ai/dsh-deepseek-account/package.json`），方法面见其 `lib/types/index.d.ts:29-119`。
- 实现 `PlatformAccount`（OAuth 流程、attempt 状态机、grant 存储都在实现里）：`@deepseek-ai/dsh-deepseek-account-platform`，由 `dsh-base` 依赖带入（`ds-bot/dev/harness/node_modules/@deepseek-ai/dsh-base/package.json:125`）。
- 推理适配器 `@deepseek-ai/dsh-llm-deepseek-account`（`dsh-base/package.json:64`）：模型路由 `deepseek-account` 的账号侧线序，`lib/index.js:451` 经 `account()?.resolveToken(connection.baseURL)` 取 token、`:475` 暴露 `token: async (url) => account()?.resolveToken(url)`。
- 凭据落地：`dsh-base/package.json:52` 的 `@deepseek-ai/dsh-credentials-local`。平台实现自述「owns login state and its opaque stored grant」（`dsh-deepseek-account-platform/lib/types/index.d.ts:63`）——grant 是不透明值。
- 阶段 A 已定的边界：账号路由不重写、继续由 DSH 自己的适配器服务（decouple:40）；账号记录暂留 DSH credentials（decouple:41）。

### 1.2 宿主侧转发模块 `src/host/account.js`（B1 登录切片，提交 `14a9dce`，2026-10-26；记录见 ROADMAP:151）

| 行为 | file:line | 调用的服务方法 |
|---|---|---|
| 只取三字段的快照 `trim()`（status / links / attempt，无 token） | `account.js:15` | — |
| 客户端元数据（version / locale / timezoneOffsetSeconds） | `account.js:19-26` | `AccountClientMetadata`（`dsh-deepseek-account/lib/types/types.d.ts:4`） |
| 取服务，缺失抛 `bot/unavailable` | `account.js:32-35` | `ctx.get?.('deepseekAccount')` |
| `accountView`：可用性 + 状态 | `account.js:37-41` | `getState()`（`index.d.ts:36`） |
| `accountStart`：已登录守卫 + webServer 检查 + 发起授权 | `account.js:48-55` | `startSignIn(client, callbackOrigin, 'desktop')`（`index.d.ts:72`）；`webServer.getOrigin()`（`dsh-host-webserver/lib/types/index.d.ts:167`） |
| `accountCancel`：按 attempt id 取消 | `account.js:57-61` | `cancelSignIn(id)`（`index.d.ts:78`） |
| `accountSignOut`：登出 | `account.js:63-65` | `signOut(client)`（`index.d.ts:84`） |
| `watch` 订阅经 `rt.accountNews` 进 feed | `account.js:70-80` → `feed.js:59-61`（`publish('account', state)`） | `watch(signal)`（`index.d.ts:91`） |
| 挂载到 rt | `account.js:82`；模块注册 `index.js:11`、`index.js:54` | — |

### 1.3 `api/bot` 四端点（`src/host/channel.js`）

- 四 case：`account-state` / `account-sign-in` / `account-cancel` / `account-sign-out`（`channel.js:183-190`），注释明示「the states the account service reports, never a token」（`channel.js:181-182`）。
- 只读集合 `READS` 含 `account-state`（`channel.js:98`）；只读宿主拒绝其余三个变更端点（`channel.js:144`），测试钉死于 `test/account-channel.test.js:107-115`。
- 契约测试：`account-channel.test.js`（255 行）以同签名 stand-in 驱动全插件——快照无 token（`:175`）、startSignIn 带 client/callbackOrigin/loginSource（`:178-186`）、缺服务或缺 webServer 的报错（`:207-224`）、cancel 带 id、signOut 带 client（`:226-236`）、feed 的 account 事件（`:239-254`）。

### 1.4 app 侧 profile 承载（`app/src/profile.mjs`）

- own 窗口的 `webserver` overlay 行：`{ id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } }`（`profile.mjs:41`，函数 `ownServicesPatchRows()` `:35-43`）。
- 注释即契约描述：唯一用途是承载账号 provider 注册的 OAuth loopback 回调 `/oauth/callback`，「on a loopback port the system picks」，不服务窗口内容，且明写「phase C's own OAuth takes the row back out」（`profile.mjs:28-31`）。用户侧说明同步在 `app/README.md:38`。
- 首启导入（`app/src/import.mjs`）：`MODEL_ROWS` 含 `llm-deepseek-account`（`:16`，过滤用于 `:73`）——导入的是用户 DSH 里账号路由的**设置行**，不是 token。

### 1.5 客户端登录入口（自有 UI 复刻，ROADMAP:151③）

- `src/client/account-dialog.js`：`OwnSignInDialog`（`:16`）；`LIVE` 相位集（`:13`）、2s 轮询（`:14`、`:42-47`）、完成自动关闭（`:53`）、取消走 `accountCancel`（`:58`）。
- 授权页在系统浏览器打开，loopback 回调落在引擎 web server、窗口不参与交换（`account-dialog.js:1-5` 注释）——即**浏览器授权与回调的生命周期完全在 DSH 服务侧**，我方只有轮询视图。

### 1.6 `auto` 联网搜索的账号 token（`ds-bot/web-search.js`）

- 账号 token 经文档化服务方法取用：`resolveAccountToken: endpoint => ctx.get('deepseekAccount')?.resolveToken(endpoint)`（`web-search.js:771`）；`resolveToken(url)` 定义见 `dsh-deepseek-account/lib/types/index.d.ts:92-97`（「Resolve a credential only for the inference origin allowed by the provider」）。
- 路由识别：`account = provider === 'deepseek-account'`（`web-search.js:748`），账号路由不带 apiKeyEnv（`:754`）；凭据选择逻辑 `credentialFor()`（`:545-559`）：账号路由取 token，失败/未登录给出 reason，成功时以 `'x-dsh-auth-token'` 头发送（`:551`）。
- provider 工厂的 deps 契约含 `resolveAccountToken`（`web-search.js:533-538`），测试可注入（`test/web-search.test.js:23`）；账号路由行为钉死于 `test/web-search.test.js:235-250`（只发账号 token、头名、via 文案）与 `:106-107`（routeOf 形状）。

### 1.7 文档化 API 与 DSH 内部行为的界线

**有类型出处、属文档化插件 API**（ROADMAP:151 的 API 出处审计逐条对照过）：`getState` / `startSignIn` / `cancelSignIn` / `signOut` / `watch` / `resolveToken`（`dsh-deepseek-account/lib/types/index.d.ts:36/72/78/84/91/97`）、`webServer.getOrigin()`（`dsh-host-webserver/lib/types/index.d.ts:167`）、词表 `AccountView.status`（`types.d.ts:35`）、`SignInAttemptView.phase` 八相位（`types.d.ts:23`：initializing / waiting-browser / exchanging / committing / succeeded / cancelled / expired / failed，本会话 sed 该行逐值计数）、`SignInErrorCode` 五错码（`types.d.ts:19`）。

**依赖 DSH 内部行为、类型层未钉死的**（自研时必须由自己提供）：

1. `/oauth/callback` 路由的注册与 HTTP 行为——类型面只约定 `callbackOrigin` 参数（`index.d.ts:68` 的「browser-accessible loopback HTTP origin」），路由本身是 platform 实现的行为，由 `profile.mjs:28-31` 的注释描述承接。
2. OAuth 授权流程本体——在 `dsh-deepseek-account-platform` 实现内（`dsh-base/package.json:125`），未作为插件 API 暴露；该包类型声明层给了 wire 应答形状（initialization / exchange，见 §2.1），但授权请求参数、state/PKCE 细节与 grant 落盘格式不见诸声明（本会话 Read `protocol.d.ts` 全文确认，未验证的需 spike）。
3. token 的刷新与吊销语义——`rejectToken`（`index.d.ts:103`）只是「推理侧拒绝时移除」的文档化面；轮换/家族吊销不在任何类型里。
4. `startSignIn` 的「有进行中 attempt 则 join、否则开新授权」是契约明文（`dsh-deepseek-account/lib/types/index.d.ts:66-67`「Join an active attempt or start browser authorization」）——我方 UI 正依赖 join 语义：遮罩关闭后重开对话框经服务接回原 attempt（ROADMAP:152③）。**不是契约的只有「新 grant 落盘即替换旧登录」**（platform 实现行为，`account.js:43-47` 注释与 ROADMAP:151 收尾①记载）。我方的 credential-stored 守卫是 host 侧自加（`account.js:51`；ROADMAP:151 收尾①「DSH 实现本无守卫」指无已登录守卫，不涉 join 契约）。
5. 「token 不上通道」由我方的 `trim()`（`account.js:15`）与测试断言（`account-channel.test.js:175`）保证，不是服务侧强制。
6. own 窗口里 `webServer` 服务的存在性依赖 profile overlay 组合（`profile.mjs:41`）。

### 1.8 未验证项（如实记）

- 登录/登出端到端真机取证：ROADMAP:151 记「真机取证（登录 / 登出端到端截图）待做」；本会话未执行，状态**未验证**。
- `dev/smoke.mjs` 账号路径：ROADMAP:151 与 orchestration:372 均记 smoke 因本机缺 `deepseek-harness` checkout / `DSH_HARNESS` 未跑；本会话亦未跑。
- 本会话未运行测试套件；文中测试数字（如 1133 例基线）引自从文档记载（c0-execution-baseline.md:32、orchestration:372），非本会话实测。
- DeepSeek 侧 OAuth/token 协议的公开文档存在性：本会话未做外网核查，**未验证**——这恰是 §二 成本判据的核心不确定项。

## 二、自研范围：逐项成本、风险与最小实现清单

分四项。机制参照两件：A-03（orchestration:93：短时 access + 每次轮换的 refresh + 重放旧 refresh 吊销整个 token 家族 + 到期前单飞刷新，作为 D2「短时可吊销 token」的机制骨架，decouple:132；D3 验收要求「token 吊销生效」decouple:134）；A-04（orchestration:94：威胁模型的残余风险显式写清楚——首接触不抗恶意 Server、指纹仅 48 位、同账号任一 client 被 Host 自动信任、账号失守=Host 失守、尚无 rekey；adopt 的是「把不保证写清楚」的纪律）。

### 2.1 OAuth 授权流程（成本主导项）

- 现状锚点：我方只有 `account.js:48-55` 的调用与 `account-dialog.js` 的轮询；授权/交换/落盘的协议细节在 platform 实现与其类型声明层（§1.7-2、§2.1）。
- 自研内容：授权 URL 构造（client metadata 同 `account.js:19-26`）、系统浏览器打开（`account-dialog.js:1-5` 同款）、attempt 状态机（相位八种 + 错误码五种，`types.d.ts:19-23`）、attempt TTL 与取消/过期语义。
- 成本：中（初判「中-高」，补入下方第三条协议证据后下调）。UI/端点/客户端侧最便宜（四端点 + 对话框 + feed 已在，重接自有服务本质是换掉 `account.js:32-35` 的 `service()` 一层）；原本贵在协议细节不在插件 API 面（§1.7-2），但降险材料有三条路：①**平台 wire 协议的类型声明**——`dsh-deepseek-account-platform/lib/types/protocol.d.ts`（本会话 Read 全文，102 行）以 zod 类型化了 initialization 应答（`authorize_url` / `authorize_id` / `expires_in`，`:37-41`）、exchange 应答（`token` / `authorized_url` / `user`，`:43-47`）、账号端点路径（`/auth-api/v0/users/current`、`/api/v0/users/get_user_summary`，`:67`）、bonus 与 logout（`:76`、`:86`、`:95`）与 loopback `loginOrigin` 校验（`:101`）；该包 MIT（`dsh-deepseek-account-platform/package.json:35`，与 `dsh-deepseek-account/package.json:33` 同许可、同版本 0.2.1-rc.2），AGENTS.md 硬规则 3 的兼容许可例外成立（用时登记 NOTICE，参照 orchestration A-06 :96）；且 `.d.ts` 是声明层——读它得 wire 形状，不等于复制实现文本（实现在 `protocol.js`，不在必读范围）。②观察 platform 运行行为写原创等价实现（C0 基线对 vendor 薄替代的纪律，c0-execution-baseline.md:152「按观察到的行为写，不复制 DSH 代码/文本」）。③DeepSeek 侧公开协议文档（是否存在未验证）。
- 风险：协议请求侧细节（授权请求参数、state/PKCE、grant 落盘格式）不在类型声明里（§1.7-2），把实现行为当契约仍会随上游变更而断；对已见诸类型的 wire 形状，上游改形状会同时改类型——可观测性反而比纯逆向好。
- 最小实现清单：①授权 URL + state 参数；②attempt 状态机（相位/错误码/过期）；③系统浏览器打开与取消；④协议观察 spike 笔记（授权、交换、刷新、吊销四段，逐段标出处：观察行为 or 公开文档）。平台面（余额/赠品：`getProfile`/`getBalance`/`getUnnotifiedBonuses`/`ackBonusNotified`，`index.d.ts:44-64`）不在范围——我方 UI 只用 `links`（`account-channel.test.js:14`）。

### 2.2 loopback 回调

- 现状锚点：`profile.mjs:41` 的 webserver 行 + `account.js:52-54` 的 `getOrigin()` 作 callbackOrigin。
- 自研内容：在自有 HTTP 出口上注册回调路由（B1 已有 `node:http` 出口基础：`outlet.js:12` 的 `createServer`、`:52` 的 token 生成、decouple:82 的「本地回环 + 自有 token」口径），收授权码、校验 state、一次性消费、完成交换；兑现 `profile.mjs:31` 的「takes the row back out」（撤 webserver overlay 行或改由自有出口承载）。
- 成本：低-中。出口与鉴权已有现成模式；新增的是路由与 OAuth 收尾的胶水。
- 风险：回环端口竞态与 localhost CSRF；与出口的端口/会话管理共存（出口已有 header/query/cookie 三态鉴权，`outlet.js:57-64`，header 读取 `:58`，回调端点必须免鉴权或单次 state 放行——这是新的安全面，需按 A-04 写清）。
- 最小实现清单：①一个回环端点 + state 校验 + 一次性消费；②端口策略（系统挑选，对齐 `profile.mjs:41` 的 `port: 0`）；③回调端点豁免鉴权的边界与理由成文。

### 2.3 token 存储与刷新

- 现状锚点：grant 存于 DSH credentials（`dsh-base/package.json:52`），不透明（§1.1）；我方的取用面只有 `resolveToken` / `rejectToken`（`index.d.ts:97/103`）。
- 自研内容：自有密钥库存 grant（阶段 A 已有 vault 体系，decouple:41 同源）、A-03 的轮换 + 重放吊销家族 + 到期前单飞刷新、`resolveToken` / `rejectToken` 等价面（供 `web-search.js:771` 与将来的自有适配器）。
- 成本：中。存储与取用面便宜；贵在**存量登录的迁移**——grant 不透明且协议在 platform 实现里，迁移大概率不可行，只能引导重登（这与保底路径的用户引导部分重叠，见 §三）。
- 风险：刷新/吊销协议能力未验证（DeepSeek 侧是否支持轮换与家族吊销未知）；若只支持「一个不透明 token + 失效重登」，A-03 只能部分落地，需在威胁模型里如实写降级（A-04 纪律）。
- 最小实现清单：①vault 存 grant + origin 绑定——文档化服务面的语义见 `dsh-deepseek-account/lib/types/index.d.ts:92-96`（resolveToken 注释「Resolve a credential only for the inference origin allowed by the provider」），实现侧配置语义见 `dsh-deepseek-account-platform/lib/types/index.d.ts:12-13`（`Config.inferenceOrigin` 注释「Exact HTTP(S) origin allowed to receive account tokens for inference and files」）；②`resolveToken` / `rejectToken` 等价；③A-03 三机制（轮换、家族吊销、单飞刷新）各配测试，协议不支持处写降级说明；④存量登录处置（重登引导 or 迁移工具）二选一定稿。

### 2.4 `auto` 联网搜索的账号 token

- 现状锚点：`web-search.js:771` 的 `resolveAccountToken`、`:551` 的 `x-dsh-auth-token` 头；DSH 自家适配器同用法（`dsh-llm-deepseek-account/lib/index.js:451/475`）。
- 自研内容：把 `deps.resolveAccountToken`（`web-search.js:535`）从 DSH 服务切到自有 token 服务；保持头名与 origin 绑定不变（服务端约定，换实现不能换契约）。
- 成本：低。factory 的 deps 注入面就是为可替换设计的（`web-search.js:532-538`），切供给了不动 `credentialFor()` 逻辑。
- 风险：头名/绑定是 DeepSeek 服务端约定，若自有服务的 token 形态不同（如 A-03 的短时 access），需确认服务端接受同一种头——未验证。
- 最小实现清单：①`resolveAccountToken` 指向自有服务；②`test/web-search.test.js:235-250` 不改断言通过；③短时 token 下的取用频率评估（单飞刷新要覆盖搜索路径的并发调用）。

### 2.5 成本小结

代码面（四端点 + 对话框 + feed + 搜索 provider 注入面）切换是**换一层服务实现**的工量；成本与风险集中在 §2.1 的协议确定性、§2.3 的存量登录迁移与刷新协议能力。其中协议确定性已有部分降险材料（§2.1 的 `protocol.d.ts` 类型声明路），不再是「只能逆向」；仍未验证的是 refresh/轮换/吊销的协议能力（本会话 Read `protocol.d.ts` 全文确认：该文件只有 initialization / exchange / 账号端点 / bonus / logout / loopback 校验面，**无 refresh 面**）与存量 grant 迁移可行性。所以本评估不给「成本不可接受」的终判，只给 §三 的触发条件与一件明确的降险动作（协议 spike，范围含 §2.1 三路证据）。

## 三、结论建议

**二选一，本文建议：C 阶段自研**（维持 decouple:140 / decouple:202 已定决策 3 的路线），理由：

1. 已定决策 3 的口径就是「C0 评估、C 自研」，且明写了保底触发条件「C0 评估成本不可接受」。本次盘点没有找到「成本不可接受」的硬证据——原本的两大不确定来源里，协议不确定性已有部分降险材料（§2.1 的 `protocol.d.ts` 类型声明），只剩存量 grant 迁移与刷新协议能力未验证；用未验证项翻转已拍板决策不合纪律。反过来，保底路径砍掉账号登录这条产品路线（影响 decouple:140 的 B1 发布阻断项：纯账号用户升级路径），同样是不可逆的产品决策，不该由一份评估默认触发。
2. 保底路径的成本被这句「API key 迁移引导」低估的风险真实存在：它要把账号用户的设置行/密钥引导做一遍（`app/src/import.mjs:16` 已有账号行的**导入**，反方向的引导无设计），且永久失去账号计费路线；这不是「便宜的退路」，是另一条产品路线（其自身交付物清单见下）。
3. 自研的最大不确定项有明确降险路径且不贵：C0/C1 期间做协议 spike，产出四段协议笔记（授权、交换、刷新、吊销）。spike 的输入比初判时充分——平台 wire 协议有 MIT 类型声明可依（§2.1 路①），执行纪律按 AGENTS.md 硬规则 3（用时登记 NOTICE）与「不复制文本」口径；refresh/吊销能力正是 spike 要回答的问题。spike 结论才是「成本可接受与否」的真正判据——本文先把判据的形态定下来。

**改判保底的触发条件**（任一成立即重新评估，报维护者拍板）：

- 协议 spike 发现请求侧细节（授权请求参数、state/PKCE、grant 落盘格式——类型声明只给应答形状，§2.1）或刷新/吊销语义无法在不依赖 DSH 实现行为的前提下复刻，观察成本超过 C 预算的可接受比例——具体阈值由维护者定，本文不擅自设数；
- DeepSeek 侧账号 token 与 API key 在能力/计费上出现一致化，账号路线的产品差异化消失；
- C0.4 双跑因账号路由受阻：账号路由的 turn 走 DSH 自家适配器（decouple:40「不重写」），若双跑场景覆盖账号路由而自有循环缺等价适配器，差异=0 不可达——此时把账号路由移出双跑场景或改判保底，需维护者裁决。

**保底路径的交付物与验收清单**（若三条触发条件任一成立、维护者拍板改判，要落的东西——二选一的另一支不能只有触发条件）：

1. **前置声明**：README / CHANGELOG 按保底口径声明「弃用账号登录 + API key 迁移」（decouple:140 明文）；改其一即同步另一个（AGENTS.md 风格节要求）。
2. **B1 发布阻断项换口径**：decouple:140 末句「纯账号用户的升级路径必须在发布说明里写清」不变——内容从自研迁移引导换成「弃登录 + key 迁移」步骤；与 appId 断代重装说明同批（decouple:142）。
3. **入口下线**：自有窗口账号登录入口下线（挂载条件 `account-dialog.js:16-17` 的 `ownSignIn` 与 Models 页 Sign in 行，ROADMAP:151③），四端点行为改判（如 `account-sign-in` 改返回带理由的不可用，参照 `account.js:33` 的 `bot/unavailable` 模式）并有测试。
4. **API key 迁移引导最小面**：引导账号用户配置 `DEEPSEEK_API_KEY` 走官方路由（路由与 env 名见 `web-search.js:47`、`:53`），或经自有 provider 行（`channel.js:171-176` 的 provider-key / provider-add 端点在位）。
5. **搜索降级文案**：`auto` 账号路由不可用时的 reason 分支已在（`web-search.js:549-551`「it is not signed in to a DeepSeek account」），确认其对最终用户的可读性。
6. **验收**：以上五项各有落库证据；B1 发布说明含纯账号用户升级路径；`account-channel.test.js` 与 `web-search.test.js` 按新口径改断言——此处允许改断言，与 C0.3「只换供给不改断言」纪律（c0-execution-baseline.md:123）不冲突：那是测试迁移期纪律，本项是产品行为变更，须单列说明。

**选自研时的验收判据**（进 C 的账号侧 gates）：

1. 协议笔记落库：授权、交换、刷新、吊销四段，逐段标注出处（观察行为 or 公开文档），未验证处显式记「未验证」；
2. 威胁模型按 A-04 纪律写清残余风险（至少覆盖：回环端点暴露面、state 重放、token 失守=推理能力失守），随 D2 安全模型定稿（decouple:132）；
3. token 机制按 A-03：短时 access + 轮换 refresh + 重放吊销家族 + 到期前单飞刷新，各配测试；协议不支持处写降级说明；
4. 契约不动：`test/account-channel.test.js` 与 `test/web-search.test.js:235-250` 在自有服务实现上**不改断言**通过（沿用 C0.3「只换供给不改断言」纪律，c0-execution-baseline.md:123）；
5. 存量登录处置定稿（重登引导 or 迁移工具），且 decouple:140 的 B1 发布阻断项（纯账号用户升级路径写进发布说明）不因本结论放松；
6. `profile.mjs:31` 的「takes the row back out」兑现：webserver overlay 行撤除，或改由自有出口承载回调（成文说明选了哪条）。

## 四、与进 C1 门槛的联动

**门槛表现状**：进 C1 = C0.4 双跑差异=0（审批 + 压缩两场景）**且** C0 账号评估产出（orchestration §3.7:287，出处引 c0-execution-baseline.md:141 与 decouple:112,140）。S4b 的完成判据有三句（orchestration:228）：①评估短文落库；②明确二选一的结论与理由；③结论同步进 ROADMAP 决策日志与 §3.7 的进 C1 门槛。如实记账：**本片落库 + §三结论明确 = 判据①②达成；③尚未做**（下文给出的落笔动作待后续提交完成）——故进 C1 的第二个门槛条件目前是**部分达成，待第③句完成后才完整达成**，不宜先行宣告达成；第一个条件（双跑差异=0）不在本片范围。

**位置勘误**（任务描述写「解耦设计 §3.7 门槛表」）：实测解耦设计无 §3.7 编号节——其节为「为什么 / 已定的行为（阶段 A、B1、B2、C、D）/ 独立化前置 / 上游同步策略 / 取代与待改的既有设计 / 不做什么 / 已知限制 / 已定决策 / 变更」；带编号的门槛表在**编排计划 §3.7**（orchestration:283-296）。账号要求在解耦设计侧的原文出处是 decouple:140 与 decouple:202（已定决策 3），本文按实际位置引用。

**结论如何写进两份文档**（本片只产出评估短文、不改其他文件；以下为建议措辞，落笔由后续提交完成）：

1. **ROADMAP §七 决策日志**（现条目体例见 :151 的 B1 登录切片条目）追加 2026-10-30 一条：记录 S4b 评估产出（本文路径）、二选一结论与理由一句话、协议 spike 列为 C0/C1 并行待办、改判触发条件。示例措辞：「2026-10-30（C0 账号评估，S4b）：`docs/dev/2026-10-30-c0-account-evaluation.md` 落库——现状盘点（account.js 四转发 + channel.js:183-190 四端点 + profile.mjs:41 webserver 行 + web-search.js:771 token 取用，全部文档化 API、零 patch）；结论建议 C 阶段自研（维持 decouple:202 决策 3），协议确定性已有 MIT 类型声明可依（dsh-deepseek-account-platform/lib/types/protocol.d.ts），未验证项剩 refresh/吊销能力与存量 grant 迁移（不透明、大概率重登引导）；降险动作 = C0/C1 协议 spike；改判保底的触发条件三条见该文 §三。本条即 S4b 完成判据第三句的落笔（orchestration:228），与 orchestration:287 的 §3.7 补注一并完成后，进 C1 门槛之二完整达成。」
2. **编排计划 §3.7**（orchestration:287）「进 C1」行的「C0 账号评估产出」处补注本文路径与结论指针，例如「——即 S4b；评估与结论见 docs/dev/2026-10-30-c0-account-evaluation.md（结论：自研）」。
3. **解耦设计**（decouple:140）无需改字（其口径已含保底路径与 B1 发布阻断项）；如需留痕，在 decouple:207 起的「变更」节追加一行「C0 账号评估产出」即可。另注意 decouple:188 的既有口径——B1 只能发 beta，「正式版要求 C0 的账号评估结论」——本片落库即该项就绪。

## 变更

- 2026-10-30 建立（S4b 指定产物；只读盘点，未改任何代码文件）。
- 2026-10-30 独立审读修订（七条 problems 与两条 missing 逐条核处；核验命令与输出见会话记录）：
  1. **相位种数更正**：`types.d.ts:23` 的 phase 联合实为 **8 值**（initializing / waiting-browser / exchanging / committing / succeeded / cancelled / expired / failed，本会话 `sed -n '23p'` 逐值计数）；§1.7 与 §2.1 两处「七相位/七种」改「八」，并列全量相位。错误码五种（`types.d.ts:19`）原正确。
  2. **origin 绑定引用更正**（原引裸 `index.d.ts:12`，实为该文件 `}` 行、全文无此句）：文档化服务面语义改引 `dsh-deepseek-account/lib/types/index.d.ts:92-96`（resolveToken 注释），实现侧配置语义引 `dsh-deepseek-account-platform/lib/types/index.d.ts:12-13`（`Config.inferenceOrigin` 注释）。
  3. **§四 改口**：S4b 完成判据三句（orchestration:228）只达成前两句，第三句「结论同步进 ROADMAP 决策日志与 §3.7」待后续提交；原「第二个条件达成」的宣称与本文自记的未落笔矛盾，改为「部分达成、待同步后完整达成」。
  4. **§1.7-4 订正**：`startSignIn` 的 join-or-start 是契约明文（`dsh-deepseek-account/lib/types/index.d.ts:66-67`；ROADMAP:152③ 的遮罩重开逻辑正依赖 join 语义），非契约的只有「新 grant 落盘即替换旧登录」；host 侧 credential-stored 守卫（`account.js:51`）的自加性质不变。
  5. **§1.4 行号**：`ownServicesPatchRows()` `:35-47` → `:35-43`（`:44-46` 属 INSTALL_ANCHOR，本会话 grep 实证）。
  6. **§2.2 行号**：三态鉴权 `outlet.js:60-65` → `:57-64`（header 读取 `:58`，`:65` 是 cookie 序列化，本会话 `sed -n '55,66p'` 实证）。
  7. **文首链接**：基线链接改全名 `2026-10-27-c0-execution-baseline.md`（原 `c0-execution-baseline.md` 断链；正文三处简称引用内容核对无误，保留并加注「下文简称」）。
  8. **补第三条协议证据路**（missing 1）：`dsh-deepseek-account-platform/lib/types/protocol.d.ts`（本会话 Read 全文 102 行）以 zod 类型化平台 wire 协议——initialization（`:37-41`）、exchange（`:43-47`）、账号端点（`:67`）、bonus/logout（`:76/:86/:95`）、`loginOrigin`（`:101`）；双包 MIT（platform `package.json:35`、account `:33`）。据此修订 §1.7-2、§2.1（成本「中-高」→「中」）、§2.5、§三 理由 1/3；并实测确认该文件无 refresh/吊销面（§2.5 的未验证项因此更具体）。
  9. **补保底路径交付物与验收清单**（missing 2）：§三 新增六项（前置声明、B1 阻断项换口径、入口下线、API key 迁移最小面、搜索降级文案、验收口径），每条带 file:line。
  10. 修订未引入无出处断言；「未验证」标注（真机取证、smoke、DeepSeek 公开协议文档、本会话未跑测试套件）维持原样。

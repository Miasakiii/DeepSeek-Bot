# 目标、事件与提案：Personal Agent 的主动性

- 日期：2026-10-26
- 状态：提案（2026-10-26 起草，待维护者拍板；拍板后删去本行，把「设计」一节改成「已定的行为」）
- 相关：
  - 设计输入（外部）：腾讯技术工程《[你的 Personal Agent 如何真正跑起来？Agent 实战指南](https://mp.weixin.qq.com/s/Nh-uiZ4N5C1qO9Uf9Im4bg)》（个人实践复盘）、阿里技术《[Personal Agent 落地思考：主动性从哪来，又卡在哪？](https://mp.weixin.qq.com/s/c5k2iwYh1O1OLA8ULf5X_A)》（分层框架）。两篇同日发布，前者是"人怎么养分身"，后者是"产品要什么基础设施"，本文借用后者分层、前者经验。
  - [DSH 让步总账](2026-10-13-dsh-concessions.md) C2：Bot 会话一律不支持 DSH 的 goal，「需要长任务自主推进时，做成 Bot 自己的功能，并能跨段保留」。本文就是这件事。
  - 既有设计：[Bot 之间派活](2026-10-16-bot-handoffs.md)、[群聊](2026-10-07-group-chat.md)、[上下文与记忆](2026-10-09-context-and-memory.md)、[角色与权限](2026-10-07-roles-and-permissions.md)、[Bot 视图](2026-10-20-widget-views.md)、[解耦主线](2026-10-22-decouple-from-dsh.md)、[愿景](../vision.zh.md) 第 2、3 条
  - 代码：`ds-bot/src/host/turns.js`、`delivery.js`、`resume.js`、`steward.js`、`memory.js`、`schedules.js`、`parts.js`、`store.js`、`channel.js`

## 为什么

DS Bot 现在是一支"反应式"的 Bot 团队：用户发消息、Bot 之间派活、派活结果交回，都能推进；但**没有人推它，它就停在那里**。团队已经有的东西不少：

- 长期身份与分段（一个 Bot 是一个身份，对话由多段 Session 组成），记忆分自己 / 群 / 团队三类，按大小与权限管理；
- 派活树：一件活交出去、结果自动往上交，等结果的 Bot 会被交回的结果唤醒；
- 用户定时任务：DSH 的 schedule 服务把到点提醒作为一条消息送进 Bot 或群的 Session；
- 状态与可见性：界面和 `list_bots` 能看到每个 Bot 的 5 种瞬时状态、在等谁、有几条没读；
- 提案式交互的底子：提问卡、视图卡、审批、以及"重启后把断掉的工作捡起来"的 resume 路径。

缺的是四件把上面这些串成"主动性"的东西：

1. **没有目标**：Bot 只有角色标签、指令和记忆，没有"我要把这件事推进到哪、怎么算完成"。C2 把 DSH 的 goal 关掉以后，这一层是空的；用户每次都得重新说一遍。
2. **没有由目标或事件发起的回合**：现有回合全部来自用户消息、群消息、派活结果、审批、重启恢复、用户写的定时任务——都是"别人推它"。没有一个回合是"它对照目标算出差什么，然后自己醒"。
3. **没有提案与认领的通道**：提问卡是"问用户一个问题"，不是"给用户一个可认领、可授权、可拒绝的推进方案"。算出来的差距只能变成一句聊天，落不成动作。
4. **没有跨 Bot 可见的"做到哪了"**：5 种状态说明"现在在干嘛"，但没有"做到哪、下一步是什么、哪些结论已确认"。团队记忆是所有 Bot 都能读的，讨论中的推断一旦写进去就会被别的 Bot 当成事实——两篇文章都点到了这个坑。

两篇文章合起来给的就是这个顺序：主动性 = 身份 × 数据源 × 记忆（有身份，数据源的变化才成为事件）；主动的本质是「目标 − 现状 = 差距」；而真正卡住人的不是 Agent 多聪明，是**责任归属**——问题是谁定义的、失败代价多大、能不能验证。所以本文定的不是"更主动的聊天"，而是**主动性基座**：目标、事件、提案、进展，外加一条贯穿规则——写入共享面的内容必须带"已确认 / 讨论中"。

## 借鉴：外部结论 → 本项目的规则

| 外部结论 | 落成的规则 | 模块 |
|---|---|---|
| 主动性 = 身份 + 数据源 + 记忆，缺一件就退化 | 唤醒必须引用一个**已确认的目标**；没有目标就没有主动回合（结构约束，不是配额） | 目标 / 回合 |
| 目标 − 现状 = 差距 → 问题 → 任务 | 差距必须是结构化的：每条带**证据锚点**和**可判定完成条件**，不是自由文本 | 目标 |
| 分层：L1–L5（谁定义问题）× 执行档位（告知 / 建议 / 执行） | L1–L3 直接执行，L4 默认只出**提案**，L5 不做（只允许"建议目标"） | 提案 |
| 授权跟着子任务走，不跟着目标走 | 目标**不携带**任何执行授权；认领提案时才按范围下发，且不能越过沙盒预设与角色权限 | 提案 |
| 失败代价三维：可撤回 / 影响谁 / 可验证 | 提案卡三个字段**必填**，缺一个不允许作为提案展示 | 提案 |
| 长周期最危险的失败是目标漂移 | 目标有过期确认；过期未确认只能提醒，不能继续推进；目标修改留 `supersedes` 历史 | 目标 |
| 每天发现问题、从不解决问题的数据（276 条 todo、0 条自闭环） | 主动回合的产物只能是"推进 / 提案 / 更新进展 / 请求确认"四选一；同一目标连续无进展要降级 | 回合 |
| 讨论中的推断被写进记忆后变成结论 | 共享面（团队记忆、live、交接）写入带 `open | confirmed`；未确认的不能当结论 | 确认状态 |
| 多分身各自会话、写同一份文件互相覆盖 | 本项目已有 `pending.json` 写前日志；live 每条只由所属 Bot 写，绝不合并写 | live |

不借的部分：文章 1 的多设备 / 云端分身同步、文章 2 结尾的产品推广，都不在本项目范围（单机、桌面休眠即停）。

## 设计（拍板后即「已定的行为」）

### 术语与对象边界

先把新对象和已有的东西分清，避免概念堆叠。**不新增"任务对象"**——[Bot 之间派活](2026-10-16-bot-handoffs.md)已定「活仍是消息，不做看板式任务对象」，本文不改。

**边界声明（与"进度查询留给独立 app"的关系）**：[Bot 之间派活](2026-10-16-bot-handoffs.md)「不做什么」写的是「任务对象、进度查询和『只提问不动手』留给独立 app」。本文不做任务对象、不做看板、不做任务级进度视图：目标是"方向 + 验收规则"，live 只是 `list_bots` 一行上下文摘要；没有"我的任务列表""进度看板"这类界面。这条边界如果维护者认为连"目标 + live"也不算插件的事，就把 P0 一并砍掉——但它同时是 C2 说的"Bot 自己的、能跨段保留的目标"的最小载体，两者需要一起拍板。

**写者纪律（只读进程）**：[上下文与记忆](2026-10-09-context-and-memory.md)规定团队只有一个写者——另一个 dsh 持有团队时，本进程只读：不判断、不压缩、不换段，记忆写入由持有团队的那个进程执行（`home-lock.js` 的 `rt.readOnly()` 就是这个判据）。本文所有写路径都跟这条：**只有持有团队的进程跑 wakes tick、生成 live、写 `state.goals` / `state.live` / `state.proposals`、发唤醒回合**；只读进程不 tick、不唤醒、不写，仍可 `list_bots` / `read_live` / `read_goal`。不这样，两个进程会重复唤醒、互相覆盖。

| 对象 | 是什么 | 生命周期 | 与目标的关系 |
|---|---|---|---|
| **目标 goal** | 一个长期的、有验收规则的方向：做什么、为什么、怎么算完成 | 跨段、跨天、跨周；开 / 等人 / 达成 / 放弃 | 本体 |
| 一件活 work（`state.works`） | 一条 `message_bot` 请求及其派活树 | 一次往来到结果交回 | 一次目标推进的一步；也可与目标无关 |
| 定时任务（DSH schedule） | 用户写的"到点提醒" | 到点即弃或循环 | L1 事件源之一，不是主动性的全部 |
| 5 种状态 | 界面/`list_bots` 的瞬时状态（在干活、等批准…） | 随回合变化，只在内存 | 回答"现在在干嘛"；live 回答"做到哪了" |
| 记忆（自己 / 群 / 团队） | 事实、偏好、纠正 | 长期，按条目增删 | 目标引用记忆，但目标不入记忆段 |
| 交接包 / 检查点 | 上下文连续性 | 一段会话内 | 不承担目标跨段（目标自己跨段） |
| 提问卡 / 视图卡 | 问用户一个问题的回路 | 一次回答 | 提案卡复用视图卡，加授权语义 |

### 目标（goal）

**定义**：`{ id, scope, ownerId, title, intent, why, acceptance[], horizon, due?, reviewEvery, status, confirmations[], supersedes? }`。

- `scope`：`team`（团队）/ `bot`（某个 Bot 自己的目标）/ `room`（群目标，P3 再做）。
- `acceptance`：1–6 条，每条 `{ id, check, evidence, doneAt?, doneBy? }`。`check` 是**可判定的完成条件**（"文件 X 存在且第 3 行是 Y"、"用户确认口径为 Z"、"`npm test` 通过"），`evidence` 是**可核对的位置**（文件路径、消息锚点 `[part 2 #1234]`、命令与输出、链接）。
- `horizon`：期望周期；`due?`：期望完成的时点（可选）；`reviewEvery`：多久需要重新确认一次（默认 7 天，团队目标可设更长）。
- `status`：`open`（推进中）/ `waiting`（等人或等外部）/ `needs_confirm`（目标过期未确认）/ `met`（达成）/ `dropped`（放弃，写理由）。
- `confirmations`：`[{ at, by, note }]`——每次确认记一条；**主动回合只能引用 `open` 且未过期的目标**。
- `supersedes`：目标被改时旧目标归档，新目标指向旧的；不原地覆盖，避免"目标漂移无迹可查"。
- **达成由人确认，不由 Bot 自封**：Bot 可以在回合里把某条 acceptance 标成 `done` 并带上 evidence（`doneBy` 记是谁报的），但目标的 `met` 必须由用户或 Main Bot 确认；`met` 的目标先在"待确认达成"里列出来。
- **活与目标的关联**（P1 起）：`message_bot` 增加可选 `goal_id`，派活树规则不变；带 `goal_id` 的活交回时，记一条该目标的推进（谁做的、结果锚点），供下一次唤醒引用。

**谁能做什么**（按[角色与权限](2026-10-07-roles-and-permissions.md)扩展，不改既有角色表）：

| | 建 / 改目标 | 确认目标 / 确认达成（`met`） | 读 |
|---|---|---|---|
| 用户 | 全部 | 全部 | 全部 |
| Main Bot | 团队目标、任何 Bot 目标；群目标（P3） | 团队目标；**用户要求时代为确认任何目标** | 全部 |
| 群管理员 | 自己群的群目标（P3） | — | 自己群的 |
| 普通 Bot | 不能自己决定；**用户要求时可建 / 改自己的目标** | —（达成由人确认） | 团队目标 + 自己的 + 所在群的 |

——这张表补的是既有权限表没有的"目标"一类，不引入新的角色，也不做权限矩阵界面（[角色与权限](2026-10-07-roles-and-permissions.md)「不做什么」）。

**存放**：

- 结构化索引与状态在 `state.goals`（`store.js` 加字段与迁移；`state.version` 仍为 1，按现有 `adopt()` 方式补默认值）。
- 正文与依据在 `memory/goals/<goalId>.md`，复用记忆的写入路径（`pending.json` 写前日志、`journal.jsonl`、删除 Bot 时归档）。目录权限按 scope：团队目标所有 Bot 可读；Bot 目标自己 + Main Bot + 用户；群目标群成员。
- **`state.json` 只放热索引与有上限的字段**（[长消息](2026-10-16-long-messages.md)：热文件每次保存整份重写，只能放有上限的数据）：`state.goals` 存标题、状态、时间、正文文件指针；长正文、依据、证据回放在 `memory/goals/` 的文件里。`state.live` 有 800 字上限，`state.proposals` 只存索引和摘要，正文进 `memory/proposals/<id>.md`。
- **不进系统提示、也不进记忆段**：记忆段每个 Session 冻结、且对话开始后新条目不进提示词（#214），`recall` 也只看记忆库。目标只通过工具（`list_goals` / `read_goal`）和唤醒消息进入上下文，提示词保持逐字节稳定；`memory/goals/` 只是借用记忆的存放与权限，不参与冻结与 `recall`。

**漂移治理**：目标超过 `reviewEvery` 没有确认 → 状态自动转 `needs_confirm`；主动回合遇到 `needs_confirm` 只能发一条"目标确认请求"（提案的一种），不能继续推进。目标被改时，进行中的回合收到的唤醒消息里会写明"目标已于 X 更新，旧理解作废"。

### 事件与主动回合（wake）

**事件源**（按落地顺序）：

| 来源 | 判断 | 阶段 |
|---|---|---|
| 目标到期 | `open` 目标有 `due`，或长时间没有进展 | P2 |
| 进展停滞 | live 显示同一目标超过 N 天无变化（结构判断，不调模型） | P2 |
| 用户定时任务 | 已有 DSH schedule；保留原样，作为 L1 | 已有 |
| 状态变化（派活交回、审批结果） | 已有回合在跑，**不产生主动回合**；只在没有回合可唤醒时才需要 | 不新增 |
| 外部数据源 | GitHub 连接器事件、工作文件夹变化、RSS | P4（可选） |

**机制**：新模块 `ds-bot/src/host/wakes.js`。

- 一个 `unref` 的 tick（默认 60s，可配）+ `state.wakes` 持久化待办；重启后接着判断（与 `resume.js` 同一纪律）。
- **只读进程整个停用**：`rt.readOnly() !== undefined` 时 tick 不跑、不投递、不写 `state.wakes`（写者纪律见「术语与对象边界」）。
- tick 只做"到期判断"，不做模型调用。
- 命中且引用到合格目标 → 组装唤醒消息 → 走 `rt.deliver` / `agent.followup` + `flush` 的既有路径投递。**注意**：`resume.js` 已经在做"DS Bot 自己发起回合"（重启后续跑），所以主动回合不是新能力类别，只是新触发源；新增的是 `source.kind = 'goal'` 与配套的 header 文案。
- **接挂点（实现时必须同步改的白名单）**：新增的 `kind` / `role` 会漏过现有判断，漏一处表现为"回合跑了但没有记录、状态错乱或历史不显示"：

  | 位置 | 改什么 |
  |---|---|
  | `delivery.js` `headerFor` / `EXCHANGE_ROLES` | 新 role 的抬头文案；**主动回合不进 `exchanges`**（它不是 Bot 之间的一件活），`EXCHANGE_ROLES` 保持不动 |
  | `turns.js` `user/message` 分支（421-423） | 新 `kind` 要能打开自己的回合；不能沿用 `user` 分支（会清掉提问卡 / 视图卡） |
  | `turns.js` `claimTrigger` / `turn/end` | 主动回合的触发与结果记录 |
  | `parts.js` 历史显示（166-174）、换段携带（723-743、963-972） | 历史里显示主动回合；换段时把未完成的唤醒带进新段 |
  | `groups.js`（980 附近的群接力判断） | **主动回合不进群**，判断里排除，避免它触发群接力 |
  | `channel.js` 的 state 视图 | 界面要能显示"它为什么说话"（唤醒记录） |

  每处都要有测试，否则出错时不报错、只表现为行为诡异。

- 投递前检查：Bot 的主动开关开着、当前没有在跑的回合、不是用户设的免打扰时段、目标 `open` 且未过期。任一不满足 → 记一条"未唤醒"及原因，等下一个 tick。
- 唤醒消息至少写清：`[Wake · goal <id> <title>]`、为什么现在醒（事件 + 上次进到哪）、差距是什么、允许的动作范围、这个回合可以做什么（推进 / 提案 / 更新进展 / 请求确认），以及**禁止**"只回一句我还在做"。

**结构治理（替代配额）**——ROADMAP §六 继承硬规则第 5 条是"不留兜底上限、治理靠结构不靠配额"，所以这里不设次数上限：

- **没有目标不主动**：唤醒必须带 `goalId`；
- **一事一回合**：同一 Bot + 同一目标同时最多一个在跑的回合；
- **一轮一报**：主动回合结束时必须写一条 live（正常路径由空闲钩子兜底）；
- **无进展降级**：同一目标连续 3 次唤醒都没有推进（没有提案、没有完成任何 acceptance、live 没有变化）→ 目标转 `waiting`，只提醒用户一次；
- **用户可停**：每个 Bot 一个"主动"开关（**默认关**），关掉后目标与 live 照常，只是不唤醒；免打扰时段是用户偏好，不是配额。

**审计**：`state.wakes` 每条记 `{ id, botId, goalId, event, at, outcome }`；界面上能点开"它为什么说话"。诊断面板给"本周唤醒 / 提案 / 认领 / 被用户打断"四个数。唤醒记录是**只追加的日志**，写 `bot/wakes.jsonl`（[长消息](2026-10-16-long-messages.md)的热文件纪律：`state.json` 只放有上限的数据，日志不整份重写）；`state.wakes` 只存还没处理完的待办，处理完即移出。

**遇到需要审批的动作就收尾**：主动回合不能停在等审批上——DSH 没有看门狗（[DSH 让步总账](2026-10-13-dsh-concessions.md) C11），回合卡住只有用户手动停；`request_secret` 这类卡片一出现本来就会结束回合，付款、删除这类动作也必须由人做（[浏览器插件](2026-10-21-browser-plugins.md)）。所以主动回合要做对外动作时，正确做法是**出提案 / 转 `waiting` / 留一条通知，然后结束**，等用户认领或批准后的下一次唤醒再接着做。

**卡住不重投**：tick 只负责"到点判断和投递"，不负责杀回合；同一目标已有在跑的回合时不重复投递。回合卡死仍然是用户手动停（C11），这条不改变。

**群**：主动回合默认只在 Bot 自己的私聊里跑（用户看得到、卡片可用）。**不主动往群里发言**——群聊已定"一次只有一个人说话"、成员发帖只叫 `@` 点到的成员；群里要推进，走"提案 → 认领 → 按认领范围发帖"或群目标（P3）。这样不破坏既有群规则，也不会让主动回合把群刷成通知流。

### 提案与认领（proposal）

**定义**：L4 的默认产物，`{ id, goalId, botId, title, gap, evidence[], action, cost, reversibility, reach, verify, scope, status, expiresAt }`。`status`：`pending`（待认领）/ `claimed`（已认领执行中）/ `deferred`（延后）/ `rejected`（拒绝）/ `expired`（过期）/ `done`（已执行，带结果锚点）。

- `gap` + `evidence[]`：差距是什么、凭什么这么说（锚点必填）。
- `action`：一句话说明要做什么；具体步骤不进提案卡。
- `cost`：预计耗时 / token / 会影响谁。
- `reversibility`：`easy`（可撤回，如只读分析、草稿）/ `hard`（难撤回，如改文件、发帖）/ `none`（不可撤回，如对外发送、删东西）。
- `reach`：`self`（只影响这个 Bot）/ `team`（影响别的 Bot 或团队文件）/ `outside`（对外）。
- `verify`：做完怎么验证，对上目标里的 `acceptance`。
- 三个字段 `reversibility` / `reach` / `verify` **必填**，host 校验缺失即拒绝展示为提案（拒绝时给可修复的错误和字段路径，与视图卡校验同一套做法）。

**通道**：

- 私聊：视图卡（`show_view` + `await_reply`）——复用既有回路（`state.views`、`view-reply`、回答作为用户消息回注）。四个动作：**认领 / 延后 / 拒绝 / 改目标**，用现成的 `options` 组件承载；选到对外或不可撤回的范围时，再弹一张 `confirm` 二次确认（[UI 标准](../design/ui-standard.md)：不可撤销的操作要再点一次确认）。v1 不改 `shared/views.js` 的蓝图形状；要更强的授权界面再单开设计。
- **"改目标"是两段式**：视图卡没有导航动作（只有 options / confirm / form / submit），所以"改目标"只把答案回给 Bot；Bot 在随后回合里读当前目标，提一份目标修改草案（又是一张确认卡）。不做"点一下就跳转"。
- **卡被撤掉不等于提案失效**：视图卡的规则是"每会话一条、新覆盖旧、普通消息即撤销"，提案对象存 `state.proposals`，有独立的 `status` 与 72h 过期。普通消息把卡清掉后，提案回到"待认领列表"；用户下一次在这个会话说话时，宿主要在回合结束时**最多再出示一次**（不循环弹），仍不处理就等它过期或用户主动问。
- **一次一个提案**：同一会话同时只有一张待认领提案卡（受 views 每会话一条限制）；宿主保证同一 Bot 同时只提出一个未决提案，其余排到后续回合，避免刷屏。
- 群聊：视图卡不支持群（[Bot 视图](2026-10-20-widget-views.md)「视图不进群聊」）。P3 的群目标是"群里发一条普通帖子（按群规则：Main Bot / 管理员走「谁来回答」，普通成员只叫 `@` 点到的成员）+ 私聊里出提案卡"，不扩展交互卡进群。
- **一件活只有一个地点**（[群聊](2026-10-07-group-chat.md)）：提案在哪个会话出的，就在哪个会话认领和执行。群里的事不能在私聊认领后跑去群里执行；要跨场合就拆成两个提案，或者等 P3 的群目标。
- 可见范围：提案属于提出它的 Bot；用户和 Main Bot 能看到全部，普通 Bot 看不到别人的提案（跨 Bot 提案的可见范围另定，P3 的 Main Bot 汇总只读不认领）。

**认领即授权**（关键规则）：

| `scope` | 含义 | 效果 |
|---|---|---|
| `read` | 只读分析、不改任何东西 | 直接跑 |
| `local` | 改 Bot 自己工作文件夹里的文件 | 直接跑（仍在沙盒预设内） |
| `external` | 对外动作：群里发帖、写 GitHub、发邮件 | **没有既存预授权时逐次走审批**，认领不预先授权 |
| `full` | 在沙盒预设内自主做完，不逐次问 | 对 `read` / `local` 有效 |

- **谁能认领**：用户，或 Main Bot 代用户认领。**提出提案的 Bot 不能自己认领自己的提案**——那等于自己给自己授权；它只能等。
- **授权属于一次执行**：`grant` 记 `{ proposalId, scope, grantedBy, grantedAt }`，只对这次认领有效；做完即失效，不是长期授权。授权范围随消息注入执行回合（`[Proposal claimed · scope local · verify …]`）。
- **既有预授权优先**：用户在浏览器插件等处给过的预授权（[浏览器插件](2026-10-21-browser-plugins.md)：发帖 / 上传 / 下载 / 删除按预授权或审批）照旧生效，提案的 `external` 只约束"没有预授权的对外动作"；认领**不能**新建预授权。付款、转账永远不由 Bot 执行。
- 认领**不能**改变沙盒预设（只有用户能设，[角色与权限](2026-10-07-roles-and-permissions.md)），也**不能**授予角色动作（建群、改别人 Bot、写团队记忆）。
- 提案默认 72h 过期（可配）；过期转"待讨论"，不自动执行；拒绝可记理由。
- 同一目标 + 同一 `action` 指纹在 7 天内不重复提（防骚扰；是"不重复同一提案"的结构规则，不是次数配额）。

### live：近期工作状态

- 每个 Bot 一份（私聊 + 每个群各一份）：`state.live[botId]` / `state.live[botId:roomId]`，≤ 800 字，字段固定：`goalId?`、`doing`（正在做什么）、`next`（下一步）、`waitingOn?`（等谁 / 等什么）、`open`（未决问题）、`updatedAt`。
- **生成方式不额外调模型（v1）**：由 host 在回合结束时从既有事件里结构化提取（最后一轮的工具调用、文件、回复要点、派活等待关系），生成一段短摘要；不另发模型请求，也就不会和记忆整理抢同一个空闲时点（[上下文与记忆](2026-10-09-context-and-memory.md)：整理一次只跑一个）。质量不够时再评估"排在记忆整理队列之后的小模型整理"。只读进程不生成 live（写者纪律）。
- 更新时机：回合结束（正常路径）；空闲钩子兜底没写上的情况。主动回合结束必须写一条。
- 读取：`list_bots` 每行增加一段 live 摘要（现有状态已有"正在做什么"，这里扩成"做到哪 / 下一步 / 未决"）；需要全文时用 `read_live`。**不写进系统提示**，同[Bot 之间派活](2026-10-16-bot-handoffs.md)「状态不写进系统提示（缓存）」的纪律。
- **群 live 按成员裁剪**：群记忆只进群成员的规矩同理——`live[botId:roomId]` 只有该群成员（和 Main Bot、用户）能读；`list_bots` 给非成员只显示"在某个群干活"，不显示该群的 `open` / `next`。私聊 live 只有本人、Main Bot、用户可读。
- 写入纪律：live 只由所属 Bot 写，一条记录一个写者，不合并写（对齐文章 1 的"几个 Agent 改同一份文件"教训）；删除 Bot / 退群时随记忆一起归档。

### 确认状态（open / confirmed）

- 共享面写入带状态：团队记忆、群记忆、live、交接笔记里的**推断**一律 `open`；用户说的、用户确认过的为 `confirmed`。
- 写入端：`remember` 增加可选 `status`，缺省按来源判定（用户原话 → `confirmed`；模型自己总结 → `open`）；记忆面板可以一键确认。
- 展示端：`open` 条目在记忆段和 `recall` 里带 `(未确认)` 标记并说明"不要当结论"；团队记忆里的 `open` 条目不参与"团队共识"这类判断。
- **迁移不回填**：旧条目保留原样、不补状态，既不标 `confirmed` 也不标 `open`（把历史推断一律标成已确认，等于把它们固化成结论，正好违背这条设计的目的）；只有新写入带状态。旧条目按"中性"显示，等被引用或被改时再落状态。
- live 同理：live 里 `open` 是"未决问题"，不追加为事实。

## 分层与授权（L1–L5 → 产品规则）

| 级别 | 谁定义问题 | 本项目里的形态 | 默认动作 |
|---|---|---|---|
| L1 | 用户定时机 | DSH 定时任务 | 直接执行（已有） |
| L2 | 用户定规则 | 操作规则、群规则、记忆里的约束 | 直接执行（已有） |
| L3 | 用户定触发条件 | 用户配置的事件（P4："PR 合了告诉我"） | 执行 + 事后通知 |
| L4 | Agent 算差距 | 目标的差距 | **只出提案**；认领后按 grant 执行 |
| L5 | Agent 推目标 | 建议目标 | 只告知，不执行；不做自动推断 |

原则：**目标本身不携带执行授权**；每一档动作在认领时单独给。对外动作无论哪一档，都走既有审批。

## 分阶段（并行轨道，不阻塞解耦主线）

每阶段都能独立发布、在 DSH 上跑，且都是 `ds-bot/` 内的改动（不动 `app/`）。

| 阶段 | 内容 | 估时 | 验收 |
|---|---|---|---|
| **P0 目标与进展** | `state.goals` + `state.live` + 迁移；工具 `create_goal` / `update_goal` / `list_goals` / `read_goal` / `read_live`；回合结束生成 live（host 结构化提取，空闲钩子兜底）；`list_bots` 带 live（群内按成员裁剪）；**不发起任何回合** | 1–2 周 | 建目标 → Bot 能读到 → 回合结束 live 更新 → 另一 Bot 用 `list_bots` 看到；权限与迁移测试；不落进提示词；非群成员看不到群 live |
| **P1 提案** | 差距结构与提案卡（私聊视图卡）；认领 / 延后 / 拒绝 / 改目标；grant 注入；对外动作接审批；过期与指纹判重 | 2–3 周 | mock 场景：目标 → 差距 → 提案 → 认领 → 执行 → acceptance 带 evidence 达成；缺三维字段被拒；超范围动作走审批；拒绝/过期不自动执行 |
| **P2 主动回合** | `wakes.js` tick + 到期 / 停滞事件 + 唤醒消息 + `source.kind='goal'` 在 `turns.js`/`parts.js` 的接挂 + 审计 + 每个 Bot 的主动开关（默认关）+ 免打扰 + 无进展降级 + 只读进程停用 | 2–4 周 | mock 下 tick 触发一轮；无目标不唤醒；开关关掉不唤醒；重启不重复；只读进程不唤醒不写；连续无进展降级；审计可查 |
| **P3 群与团队** | 群目标；群里的提案通知；Main Bot 的"团队进展"汇总（只读） | 2–3 周 | 群目标权限正确；群里不新增交互卡；汇总不产生新回合 |
| **P4 外部事件源**（可选） | GitHub 连接器事件、工作文件夹变化、RSS | 待估 | 事件到达只唤醒、不自动对外 |

先做 P0 + P1，再做 P2：**没有目标和提案，主动回合只会变成噪声**（文章 2 的 276 条 todo 就是这个顺序做反的结果）。

分阶段还留了一条退路：**P0 / P1 完全不依赖定时器**。如果维护者判定"插件自己起 tick 发回合"越出 DSH 能力边界（AGENTS.md 硬规则 1 的解释问题），P0/P1 照常落地，P2 等 C 的自有循环或另行拍板——这两步的收益（目标可跟踪、Bot 知道做到哪、差距能变成可认领的提案）本身就不需要主动发起回合。

## 与解耦主线和上游同步的关系

- P0–P3 只改 `ds-bot/`，不影响 A / B1 的验收，也不新增 DSH 依赖：只用已有公开面（`sessionController`、`agent.followup`、`createUserMessage`、`ctx.on('agent/status')`、`ctx.effect`）。
- 新增文件为主（`goals.js`、`proposals.js`、`wakes.js`、`live.js`），热点文件改动集中在：`index.js`（MODULES）、`store.js`（state 字段 + 迁移）、`channel.js`（端点）、`turns.js`（新 source kind 接挂）、`parts.js`（换段携带）、`tools.js`（新工具）、`memory.js`（状态字段）、`src/client`（面板与卡片）。
- 到 C 阶段，`wakes.js` 的"投递"是唯一需要换的 seam（DSH 消息注入 → 自有循环注入）；目标 / 提案 / live 数据与规则不受影响。C0 的 `rt.host` 契约层正好把 `ctx.on('agent/status')`、`sessionController` 这类调用收进去。
- 上游 merge：改 `turns.js` / `memory.js` / `parts.js` 是冲突热点，按 ROADMAP §五 每周跟进的节奏做，新文件优先、少动既有行。

## 验收与度量

- 每阶段：`npm test` + `build --check` + lint 全绿；改到 `index.js` / `src/host/` 跑 smoke；界面改动真机截图。
- 产品度量（诊断面板，只用于观察，不做 gate）：每周唤醒数、提案数、认领数、采纳率、目标 `met` 数、live 新鲜度（最久未更新的 Bot）、用户关掉主动的 Bot 数、被用户打断的唤醒数。
- 反噪声自检：任意一周里，若"无进展唤醒"占唤醒总数的一半以上，视为设计需要回调（不是用户的问题）。

## 不做什么

- 不做 L5 自动执行；**不推断用户没说出口的目标**（文章 2 引的隐私争议）。
- **不复用 DSH 的 `goals` 服务**：C2 已决定 Bot 会话不用它（工具面在 `tools.js` 里被显式屏蔽），且它随 DSH 消失；目标必须是 DS Bot 自己的数据。
- 不做配额式限流（ROADMAP §六 第 5 条）；用"没有目标不主动 + 一事一回合 + 无进展降级"的结构治理。
- 不做看板式任务对象（[Bot 之间派活](2026-10-16-bot-handoffs.md)已定）；目标不是任务板，活仍是消息。
- 不改群聊"一次只有一个人说话"和"谁回答"的规则；群内不新增交互卡。
- 不做云端分身 / 多设备同步（本项目单机，桌面休眠即停）。
- 不在 C0/C 之前动循环，不做工具级硬隔离。
- 不做自动对外发送（发帖、PR、邮件）：对外动作永远逐次审批，付款类动作永远不由 Bot 执行。
- 不把目标或 live 写进系统提示（缓存纪律）。
- 不把目标存成记忆条目塞进记忆段（大小上限 + 冻结语义都不合适）。

## 已知限制

- **授权是声明式 + 事后复核，不是硬隔离**：C 之前工具执行在 DSH 里，host 无法逐次拦截"这个子任务只能改这些文件"；能保证的是对外动作走审批、越界在回合结束复核并标记。工具级隔离要等 C 的自有工具面。
- **UI 要补标准**：提案卡是新界面，得按 [UI 标准](../design/ui-standard.md) 补进第 10 节（既有"警告色未定""不可撤销操作二次确认"都要对上）；文案按标准走——说结果，不写过程，源文案英文 + `i18n.js` 中文。
- **主动回合做不完必须审批的事**：无人值守时只能出提案 / 转 `waiting`，不能替用户批；付款、删除、`request_secret` 这类动作永远停在人这一步。
- 目标的"可计算"依赖模型自述 + host 结构校验，没有独立验证器；evidence 仍需人抽检（"能验证才算完成"是方向，不是已达成）。
- 主动回合消耗 token；单机、无云端，桌面关了就不工作。
- live 由 host 结构化提取，不是模型总结：省一次调用、也不和记忆整理抢空闲时点，但会丢细节、读起来偏机械；它是索引，不是事实来源，要看原文用 `read_own_chat`。
- 确认状态会改记忆格式与显示；旧条目不回填状态（显示为中性），历史里被误当结论的推断不会自动纠正。
- 提案有两个生命周期（卡片会被普通消息撤销，对象按 72h 过期），实现时要在界面上说清楚，否则用户会以为"卡没了=提案没了"。
- `bot/wakes.jsonl` / `state.goals` / `state.live` / `state.proposals` 持续增长，归档策略与回执归档一起另定（P0 先定上限字段与文件分层的纪律，具体策略后定）。

## P0/P1 最小范围确认（拍板材料，2026-10-27）

> 本节是拍板材料，不是已定设计：逐条给建议答案与理由，**每条都待维护者勾选**，勾选前不动代码。建议与 [Personal Agent 趋势借鉴](2026-10-27-personal-agent-borrowings.md) §九「proactivity 自身的 8 条待拍板」的建议一致（2026-10-27-personal-agent-borrowings.md:516-523），本节补的是理由、代码证据与被否决后的范围变化。行号均为 2026-10-27 在分支 `feat/a-own-llm-core` 上实测。

### 逐条处理：影响 P0/P1 的待拍板项

**第 1 条 · 目标作用域 v1（待维护者勾选）**

- 建议答案：v1 只做 `team` + `bot`，`room`（群目标）放 P3（borrowings.md:516 同）。
- 理由：群目标要同时过三道既有边界——视图卡不进群（[Bot 视图](2026-10-20-widget-views.md)：2026-10-20-widget-views.md:121「视图不进群聊」）、群提案只能走普通帖子 + 私聊卡（本文 167 行）、群权限表要扩（本文 85 行「群管理员：自己群的群目标（P3）」）。三道都在 P3 批次一起做才不用返工；`scope` 枚举里 `room` 先留着（本文 70 行），后续补不用迁移。
- 若被否决（v1 就做群目标）：P0 估时 +1–2 周，提前碰 P3 的群交互与群权限边界；P0 验收（本文 222 行）要加群目标权限用例。

**第 2 条 · live 更新方式（待维护者勾选）**

- 建议答案：host 在回合结束时结构化提取（v1），不调模型、不做 `note_progress` 工具（borrowings.md:517 同）。本文正文已按此写（本文 190 行「生成方式不额外调模型（v1）」），此条是把待拍板项对齐正文。
- 理由：空闲时点已被记忆整理占用且「整理一次只跑一个」（[上下文与记忆](2026-10-09-context-and-memory.md)：2026-10-09-context-and-memory.md:112；代码为串行链 `reviewChain`，`ds-bot/src/host/memory.js:1677`、`memory.js:1689-1700`）——小模型方案要么排队要么破坏这条纪律；`note_progress` 依赖模型自觉调用，「一轮一报」（本文 137 行）落不到实处。结构化提取要的数据回合结束时都在手上：`turns.js` 的 `case 'turn/end'`（`ds-bot/src/host/turns.js:524`）在 534-547 行清空 entry 之前，texts、lastText、lastCalled、tool/calls、info 都可读。
- 若被否决（改小模型或工具）：`state.live` 的字段与裁剪不变，P0 估时 +0.5–1 周；生成挂点从 turns.js:524 换成 `agent/status` idle 定时器（同形于 `memory.js:1703-1729` 的记忆整理调度，需并入「一次只跑一个」队列）或 tools.js 新工具 + 提示词规则。

**第 3 条 · 确认状态的实现方式（待维护者勾选）**

- 建议答案：只在团队记忆 / live 上加前缀标记，不动记忆条目格式；旧条目不回填（本文 201 行已定；borrowings.md:518 同）。
- 理由：条目格式是 AgentMemoryRepo 的一行一条 Markdown（2026-10-09-context-and-memory.md:93），改成元数据字段要动 `memory.js`（1748 行，上游 merge 冲突热点，本文 237 行）、`pending.json`/journal 写入链（2026-10-09-context-and-memory.md:117）与面板、FTS 展示一整条链；live 的 `open` 本来就是「未决问题」字段（本文 189、202 行），前缀标记恰好覆盖这两处。
- 阶段归属注记：分阶段表没有单列确认状态（本文 222-226 行）。最小范围把「团队记忆前缀标记（`remember` 加可选 `status` + 展示端前缀）」随 P1 落地（memory.js 写入路径加可选参数，少动既有行）；live 的 `open` P0 就有。若维护者希望提前到 P0，P0 估时 +2–3 天。
- 若被否决（改成条目元数据 `[status: …]`）：P1 之外新增记忆格式改版一片（估时 +1 周上下），上游 merge 冲突面扩大到 memory.js 主体。

**第 5 条 · 提案卡复用视图卡（待维护者勾选）**

- 建议答案：复用视图卡（`options` / `confirm`），不新组件；`state.proposals` 与 `state.views` 分开存（本文 165 行；borrowings.md:520 同）。
- 理由（代码）：视图蓝图的可回答件只有 `options / confirm / form / submit` 四种、没有导航动作（`ds-bot/src/shared/views.js:11` 的 `ANSWERS`）——本文 164 行的「改目标两段式」正是照这个写的。`options`（views.js:34：`id/options/multi`）承载认领/延后/拒绝/改目标四个动作，`confirm`（views.js:35：`confirmLabel/cancelLabel`）承载不可撤销动作的二次确认；`state.views` 每会话单键（`show_view` 写入 `ds-bot/src/host/tools.js:695-701`）天然落实「一次一个提案卡」（本文 166 行）；提案本体独立 `status` + 72h 过期，卡被普通消息撤掉（turns.js:502-505）不影响提案。认领回注的既有回路就是 grant 注入点（见 P1 清单）。
- 若被否决（新组件）：P1 估时 +1–2 周（新蓝图、新端点、客户端渲染），且要先按 UI 标准第 10 节补新组件规范（本文 261 行已知限制）。

**第 8 条 · 「进度查询留给独立 app」的边界（待维护者勾选）**

- 建议答案：目标 + 一行 live 不算越界；不做任务级进度视图、不做看板（borrowings.md:523 同）。与 [Bot 之间派活](2026-10-16-bot-handoffs.md)「不做什么」的原文并存：那句话（2026-10-16-bot-handoffs.md:114）留的是任务对象与进度**查询界面**，本文做的是 C2 欠账的载体（[DSH 让步总账](2026-10-13-dsh-concessions.md) C2，2026-10-13-dsh-concessions.md:17「需要长任务自主推进时，做成 Bot 自己的功能，并能跨段保留」）。live 是 `list_bots` 现有 `now:` 一行的扩展（`tools.js:69`，`rt.statusOf` 来自 `handoffs.js:219`），不是界面。
- 两条边界需要一起拍板（本文 52 行边界声明已写明）。若维护者认为连「目标 + live」也越界：按本文待拍板第 8 条的退路「P0 只做目标、不做 live」（本文 384 行）；若连目标也判越界，C2 要求的「Bot 自己的、能跨段保留的目标」就没有载体，本文整体挂起、另找方案。
- 若被否决（只砍 live）：P0 砍掉 live 生成（turns.js:524 挂点）、`list_bots` 扩展与群裁剪三处，估时 −3–5 天；P1 提案的 `verify` 仍可对上 `memory/goals/` 里的 acceptance 证据。

### P2 / 挂载事项（不在 P0/P1 范围，建议供后续拍板）

- **第 4 条 · 主动开关默认值（P2 事项，待维护者勾选）**：开关本身是 P2 的（本文 139、224 行）。建议默认关，P2 先自用、P4 再评估默认开（borrowings.md:519 同）。不影响 P0/P1：目标与 live 照常，没有「唤醒」可言。
- **第 6 条 · 挂进 ROADMAP §四并行轨道（挂载事项，待维护者勾选）**：建议挂，与 borrowings 决策单第 1 条一起处理（2026-10-27-personal-agent-borrowings.md:502、521）。挂不挂不改变本文任何行为定义，只影响排期位置。
- **第 7 条 · P2 的 tick 边界（P2 事项，待维护者勾选）**：建议「不算越界」——投递路径是现网用法（`resume.js` 重启续跑、`roster.js` 新 Bot 开场、`groups.js` 群成员回合都经 `rt.deliver` / `agent.followup`，本文待拍板第 7 条已列（本文 383 行）；borrowings.md:522 同），需维护者确认。P0/P1 不受影响：P0/P1 不建 wakes tick、不发起主动回合。

### P0 最小范围清单

对象字段（照抄原文，本文 68、71、73、189 行）：

| 对象 | 字段 |
|---|---|
| goal | `{ id, scope, ownerId, title, intent, why, acceptance[], horizon, due?, reviewEvery, status, confirmations[], supersedes? }`；`scope ∈ team/bot`（`room` P3）；`acceptance` 每条 `{ id, check, evidence, doneAt?, doneBy? }`；`status ∈ open/waiting/needs_confirm/met/dropped` |
| live | `state.live[botId]` / `state.live[botId:roomId]`：`{ goalId?, doing, next, waitingOn?, open, updatedAt }`，≤ 800 字 |

落地方式（每处为 2026-10-27 实测行号）：

| 项 | 位置与方式 |
|---|---|
| `state.goals` / `state.live` 进 state.json | `ds-bot/src/host/store.js:22` 的 state 模板加键（现模板只有 works/requests/questions/views/prefs/switching，无 goals/live/proposals），`adopt()` 里照 `state.works/requests/views` 的既有写法补默认（`store.js:162-164`：null/非对象/数组即重置为 `{}`）；`state.version` 仍为 1（readFileState 只认 `version === 1`，`store.js:96-99`），老团队无感升级。state.json 每次保存整份重写（`store.js:297-334`），goals 只放有上限索引，正文进 `memory/goals/<goalId>.md`（本文 94 行） |
| 工具五件 `create_goal` / `update_goal` / `list_goals` / `read_goal` / `read_live` | 名字进 `ds-bot/src/host/constants.js:64-71` 的 `TEAM_TOOLS`（普通 DSH Agent 会话按这份名单剥离团队工具，`agents.js:53`）；注册照 `list_bots` 的样例（`tools.js:57-82`，`ctx.tools.register(defineTool(...))`）；逻辑放新 `goals.js`，经 rt 互调。**名字冲突**：DSH 自带 goal 工具 `create_goal/update_goal/get_goal` 现被整体屏蔽（`tools.js:18` `GOAL_TOOLS`、`tools.js:19` `HIDDEN_TOOLS`；restrict 在 `tools.js:712-726`，goal 服务 block 在 `tools.js:745-771`）——P0 落地时 HIDDEN_TOOLS 去掉 DS Bot 自己开始提供的名字、至少保留对 DSH `get_goal` 的屏蔽，`tools.js:730-732` 的 guard 与测试同步 |
| live 生成挂点 | 正常路径：`case 'turn/end'`（`turns.js:524`）内、entry 字段清空（`turns.js:534-547`）之前加一次 `rt.liveFromTurn?.(id, …)` 调用，提取逻辑放新 `live.js`；空闲兜底：`live.js` 自己挂 `ctx.on('agent/status')` 的 idle 定时器（同形于 `memory.js:1710-1729` 的记忆整理调度），不改 memory.js |
| 写者纪律 `rt.readOnly()` | 判据本体在 `store.js:59-64`（经 `store.js:426` 挂上 rt），锁来自 home-lock.js 的 `claim()`（`ds-bot/src/host/home-lock.js:69-94`）。P0 所有写路径（goals/live）过 `rt.readOnly() === undefined` 判，先例：`memory.js:1694`（记忆整理只由写者跑）、`channel.js:143-144`（只读宿主对不在 `READS` 名单（`channel.js:98`）的端点一律 `fail(readOnly, 'bot/read-only')`） |
| `list_bots` 扩展 | `tools.js:57-82`，在 69 行 `now:` 之后附一段 live 摘要；实现放 `live.js`，`list_bots` 调 rt |
| 群 live 按成员裁剪 | 读侧按成员过滤，先例 `visibleRooms`（`tools.js:55`：Main Bot 或本群成员才可见）；规矩同群记忆「只进群成员」（2026-10-09-context-and-memory.md:106） |
| 不进系统提示、不进记忆段 | prompt.js 的注入面不加新字段（`ds-bot/src/host/prompt.js:40` 起 install）；记忆段冻结照旧（`memory.js:924` 起的提示词规则、2026-10-09-context-and-memory.md:122）；目标只经工具输出进上下文，`memory/goals/` 只借记忆的存放与权限、不参与冻结与 `recall`（本文 95 行） |

### P1 最小增量清单

- `state.proposals` 只存索引 + 摘要，正文进 `memory/proposals/<id>.md`（本文 94 行）；进 state 模板与 `adopt()` 的方式同 P0。
- 提案卡复用视图卡：`options` 承载认领/延后/拒绝/改目标，`confirm` 二次确认（`reversibility: none` 或 `reach: outside` 时再弹一张，本文 163 行）；「改目标」两段式（本文 164 行）。
- grant 注入执行回合的机制点（turns.js 不为此改；注入代码是 host 侧新代码，落在 channel.js 的认领端点，不碰 parts.js——`viewReply`（`parts.js:92-106`）只做确定性组装、没有可塞提案头的扩展点）：认领动作走 channel.js 新增的提案认领端点，host 在组装回注消息时把 `[Proposal claimed · scope … · verify …]` 头写进文本（本文 181 行），再走既有回注回路：`agent.followup(createUserMessage({ content, source: { kind: REPLY_KIND, … } }))` + flush（同形于 `view-reply` 的 `channel.js:405-406`）→ turns.js `case 'user/message'`（`turns.js:409`）开启执行回合；grant 记进 `state.proposals` 对应条目。
- `external` 无既存预授权逐次走既有审批（本文 177、182 行）：审批面在 `ds-bot/src/host/approvals.js`（install 于 `approvals.js:9`，rt 面 approvalsView/waitsForApproval/answerApproval/cancelApprovals 在 `approvals.js:68`），端点 `approval-answer`（`channel.js:319`）；认领不新建预授权，付款类动作永不执行。
- 72h 过期（可配，过期转待讨论不自动执行，本文 184 行）；同目标同 `action` 指纹 7 天判重（本文 185 行，结构规则不是配额）。
- 认领人限用户 / Main Bot，提出提案的 Bot 不能自认领（本文 180 行）；一次一个提案卡（`state.views` 每会话单键 `tools.js:695-701` 天然保证 + 宿主保证同一 Bot 同时只一个未决提案，本文 166 行）。

### 明确不做（P0/P1）

- P2 全部不做：`wakes.js`、主动回合、`source.kind='goal'` 在 turns.js/parts.js/groups.js/delivery.js 的接挂、审计 JSONL、主动开关、免打扰、无进展降级、只读进程停 tick。
- P3 不做：群目标、群提案通知、Main Bot「团队进展」汇总。P4 不做：外部事件源。
- 退路照原文（本文 230 行）：**P0/P1 不建 wakes tick、不发起回合**——原文的「完全不依赖定时器」指的就是不建主动回合的 tick；P0 清单里 live 兜底用的是单发 idle 定时器（`setTimeout` + `unref`，与记忆整理调度同形，`memory.js:1723-1727`），属既有模式、不触发待拍板第 7 条的 tick 边界问题。若维护者判定插件自起 tick 越出 DSH 能力边界（待拍板第 7 条），P0/P1 照常落地，P2 等阶段 C 的自有循环或另行拍板。

### 热点文件改动面预估

| 文件 | 改动 | 性质 |
|---|---|---|
| `index.js` | import 三行 + MODULES（`index.js:54`）加 goals/proposals/live | 纯新增 |
| `store.js` | 模板（`store.js:22`）加 goals/live/proposals 三键 + `adopt()` 补默认（照 `store.js:162-164` 式样） | 新增为主，不动既有行 |
| `channel.js` | state 视图加 goals/live/proposals 摘要（`channel.js:46-82` 一带的对象加键）；新端点（switch 内加 case，`channel.js:145-526`）；`READS` 名单（`channel.js:98`）按需加 | 新增 case 为主，既有行少动 |
| `tools.js` | 新工具注册块；`GOAL_TOOLS`/`HIDDEN_TOOLS` 调整（`tools.js:17-20`）；`list_bots` 加 live 行（`tools.js:65-71` 内） | 两处动既有行（:17-20 与 list_bots 一行区域），其余新增 |
| `memory.js` | 仅第 3 条按建议通过时：`remember` 写入路径加可选 `status` + 展示端前缀（随 P1） | 少动既有行 |
| `src/client` | Bot 面板目标/live 展示、提案卡渲染、记忆面板确认按钮 | 新增组件为主 |
| 新文件 | `goals.js` / `proposals.js` / `live.js`（+ 各自测试），为改动主体 | 新增 |
| `turns.js` | 仅 `turn/end` 内加一次 live 提取调用（`turns.js:524-533` 区域） | 一处，少动 |

（P0/P1 不碰 parts.js / groups.js / delivery.js——那些接挂全在 P2。）

### 验收口径

照原文：P0「建目标 → Bot 能读到 → 回合结束 live 更新 → 另一 Bot 用 `list_bots` 看到；权限与迁移测试；不落进提示词；非群成员看不到群 live」（本文 222 行）；P1「mock 场景：目标 → 差距 → 提案 → 认领 → 执行 → acceptance 带 evidence 达成；缺三维字段被拒；超范围动作走审批；拒绝/过期不自动执行」（本文 223 行）。每阶段五门照旧：`npm test`、`node scripts/build-client.mjs --check`、`npm run lint`、界面改动真机截图、改到 `index.js`/`src/host/` 加跑 smoke（本文 241 行；AGENTS.md「Commands」同口径）。

### 行号勘误（本节核实中发现的正文行号漂移；按约定不改正文，列此备查）

- 本文 122 行「`turns.js` `user/message` 分支（421-423）」→ 现 `case 'user/message':` 在 `ds-bot/src/host/turns.js:409`；该分支里清提问卡/视图卡的逻辑在 `turns.js:496-506`。
- 本文 54 行「（`home-lock.js` 的 `rt.readOnly()` 就是这个判据）」→ `rt.readOnly()` 定义在 `ds-bot/src/host/store.js:59-64`（`store.js:426` 挂上 rt）；home-lock.js 提供的是锁本身（claim 在 `home-lock.js:69-94`）。判据语义不变，出处文件应为 store.js。
- 核实未漂移的引用：`tools.js:17-20`（borrowings.md:128 引）、parts.js:166-174（`historyEntry`，`parts.js:155` 起）、parts.js:963-972（换段携带提问卡/视图卡）、groups.js 980 附近（群接力 `opens` 判断，`groups.js:978-980`）、bot-handoffs.md:114。
- 路径注记：`store.js` 的完整路径是 `ds-bot/src/host/store.js`（本文与 borrowings 引用时均写作 `store.js`）。

## 待拍板

1. 目标作用域 v1：只做 `team` + `bot`，群目标放 P3？还是 v1 就把群目标做进来？
2. live 更新方式：空闲小模型调用（与记忆整理同时机、独立任务），还是给 Bot 一个 `note_progress` 工具自己写？前者不打扰模型但可能滞后，后者准但多一个工具。
3. 确认状态是否动记忆格式：改条目的元数据字段（`[status: …]`），还是只在团队记忆 / live 上加前缀标记（改动小、但只能覆盖这两处）？
4. 主动开关默认关（P2 先自己用，P4 再默认开）还是按 Bot 逐个开？
5. 提案卡复用视图卡，还是新组件（复用省事，但 `state.views` 的语义要扩出"认领"）？
6. 本设计是否挂进 [ROADMAP](../../ROADMAP.md) §四「并行轨道」，作为与 UI / fleet CLI / 发布链并列的第五条？
7. **P2 的 tick 边界**：插件自建 `unref` tick、用 `rt.deliver` 投递主动回合，算不算 AGENTS.md 硬规则 1 里"DSH 里没有的能力"？（建议不算：投递路径是现网用法——`resume.js` 重启续跑、`roster.js` 新 Bot 开场、`groups.js` 群成员回合都这么投；不新增 DSH 能力、不打补丁。但这条得维护者确认，P0/P1 不受影响。）
8. **"进度查询留给独立 app"这条边界**：本文的目标 + live 是否算把进度查询提前做进插件？建议限定为"不做任务级进度视图、不做看板"，只保留目标与一行 live 上下文；若维护者认为越界，P0 就只做目标、不做 live。

## 变更

- 2026-10-26：起草。两篇外部文章作为设计输入；按 `docs/plans` 格式写"设计（拍板后即已定行为）"，未拍板前不动代码。
- 2026-10-26：按既有设计与代码核对补写——接挂点白名单（`delivery.js` / `turns.js` / `parts.js` / `groups.js`）、提案本体与视图卡分开存（每会话一张、普通消息即撤销）、不可撤销动作二次确认、审批退路与无看门狗、提案的场合边界（一件活只有一个地点）、不复用 DSH `goals` 服务。
- 2026-10-26：按第三轮设计核对再修一轮——**只读进程写者纪律**（不 tick、不唤醒、不写 goals/live/proposals）、"进度查询留给独立 app"的边界声明、群 live 按群成员裁剪、视图卡没有导航动作所以"改目标"改两段式、既有预授权优先于提案的 `external`、认领人限用户 / Main Bot（提案 Bot 不能自认领）与 grant 归属、`met` 确认权对齐、旧记忆条目不回填状态、`state.json` 只放有上限索引（正文进文件，wakes 走 JSONL）、live 改 host 结构化生成（不额外调模型）。
- 2026-10-27：加「P0/P1 最小范围确认（拍板材料）」，逐条给出待拍板 1/2/3/5/8 的建议答案与 P0/P1 最小范围清单（含热点文件改动面、验收口径与行号勘误），每条待维护者勾选。
- 2026-10-27：复核修订——更正新节两处内部引用的行号（原写「本文 278/279 行」是插入新节前算的行号，实指待拍板第 7/8 条，现为 383/384 行）；「明确不做」的退路改述为「不建 wakes tick、不发起回合」，并注明与 live 兜底 idle 定时器（`memory.js:1723-1727` 同形）的关系；写明提案认领头的注入代码落在 channel.js 新端点、不碰 parts.js。

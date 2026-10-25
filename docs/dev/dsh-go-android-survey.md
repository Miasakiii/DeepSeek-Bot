# 调研：dsh-go —— 第三方在安卓上以 proot 跑 DSH web 的实现

- 日期：2026-10-25
- 相关：解耦主线阶段 D（移动端）（[设计](../plans/2026-10-22-decouple-from-dsh.md)）；[桌面应用设计](../plans/2026-10-16-desktop-app.md)
- 依据：对 `dsh-go 0.9.0 内测版` APK（SHA-256 `1ca3d80a46da1d089211428ae5fe77e79bb89a7c2128c88b77a2643a0211e418`，微信传播、自签名证书 `CN=dsh-go, O=DSH-TUI, C=CN`，证书指纹 `1437149213cd8114b3f848dd2a0e66a8685877641ec327d7dd6cb700243452b3`）的纯静态分析：解包、清单解码、so/资源字符串。未安装、未运行。
- 性质：第三方社区项目（GitHub `ccch1mneyyy/dsh-go`，论坛 `forum.dshtui.com`），**不是 DeepSeek 官方产品**。本文只记录事实与可借鉴点，不代表本仓库采纳其做法；其中与本项目硬规则冲突的部分在 §七明确标出。

## 一、它是什么

一个安卓 App（Flutter 原生壳，启动器显示名「DSH」，包名 `io.github.ccch1mneyyy.dsh_app`，versionName 0.9.0 / versionCode 10251518，minSdk 26、**targetSdk 28**）。它把一台完整的「Linux + Node + DSH」装进 App 私有目录，免 root 用 proot 跑起来，再让原生界面通过 WebView 连本机 `dsh web`。用户在手机上得到的是完整 DSH 网页版 + 一层原生界面（终端、文件、模型、插件、定时任务、技能、工作区、账号、社区等页面）。

它同时回答了「DSH 插件能不能原样跑在手机上」：能——插件生态没动，pnpm 装进 rootfs 里的 DSH 即可。它的引擎锁 **DSH 0.2.1-rc.2**（本仓库已合 0.2.2，比它新）。

## 二、身份与内容指纹

| 项 | 值 |
|---|---|
| 包名 / 版本 | `io.github.ccch1mneyyy.dsh_app`，0.9.0（10251518） |
| 签名 | 自签名，`CN=dsh-go, O=DSH-TUI, C=CN` |
| UI 框架 | Flutter（Dart AOT `libapp.so` 约 26MB；`classes.dex` 为 Android 桥接层） |
| ABI | 声明 arm64-v8a / armeabi-v7a / x86_64，但 **proot 与 rootfs 只有 arm64-v8a**：引擎只在 arm64 手机可用 |
| rootfs | `assets/runtime/rootfs-arm64-v8a.tar.xz`，158MB 压缩 / 786MB 解压（25207 文件、5218 目录、1680 符号链接），Ubuntu 24.04.5 + Node 24.22.1 + pnpm 11.28.5 + DSH 0.2.1-rc.2（装在 rootfs 内 `/opt/dsh/node_modules/@deepseek-ai/dsh`） |
| runtime 版本串 | `r5-dsh0.2.1-rc.2-node24.22.1-ubuntu24.04.5-b3f6c96ee2f2` |
| 更新通道 | GitHub Releases：`releases/latest/download/update.json`（另有 api.github.com 查 latest；jsdelivr / ghfast.top / gh-proxy.com 国内加速镜像） |
| 社区 | 内置 `community.json` 并从 GitHub raw 刷新；分享链接 `go.dshtui.com/share/`；论坛 `forum.dshtui.com`；另有 `dsh.r2049.cn` |
| 构建可复现 | manifest 记录 ubuntu 基础镜像、node、DSH lockfile、pnpm integrity 的 SHA-256，`sourceDateEpoch=1767225600`（2026-01-01T00:00:00Z） |
| 生态线索 | 代码字符串里引用 `Fei2411/DeepSeek-Bot`、`CikeSeven/phase` 两个第三方仓库 |

## 三、运行架构

### 启动

`assets/runtime/manifest.json` 是整份引擎的单一事实来源，App 按 `launch.argv` 模板拼命令行：

- proot（来自 Termux 的 deb 包，`--kill-on-exit --link2symlink --sysvipc`），rootfs 在 `filesDir/runtime/rootfs`；
- 绑定 `/dev`（含 urandom→random）、`/proc`（含 fd→`/dev/fd` 三件套）、`/sys`、`/system`、`/apex`，`/dev/shm` 与 selinux 用 rootfs 内空目录占位；
- 干净环境（`env -i`）+ 固定 PATH/`DSH_HOME=/root/.dsh`/`pnpm_config_registry=npmmirror`，预留 `{GUEST_ENV}` 槽位注入 App 侧键值（`DEEPSEEK_API_KEY`、`TZ` 等）；
- 最终执行 `/usr/local/bin/dsh web --patch /etc/dsh-app/dsh-web.patch.yml --host 127.0.0.1 --port {PORT} --no-open`。

`{NATIVE_LIB_DIR}` 要求 so 走 `useLegacyPackaging` 解压到磁盘；proot/talloc 来自 Termux 包，仅做了 `DT_NEEDED`/`SONAME` 改名补丁（`libtalloc.so.2 → libtalloc.so`），并记录原始哈希与补丁后哈希。

### 认证

- DSH 启动完成时向 stdout 打一行 `dsh web: http://127.0.0.1:<port>/?token=<43 位 base64url>`，manifest 给出逐字符正则；
- WebView 要么直接加载 token URL，要么原生侧 `GET /?token=` 走 303 换 `dsh-auth-<id>=v1.…` cookie（`Path=/; HttpOnly; SameSite=Strict`）再 `CookieManager.setCookie`；
- 健康检查：TCP 通 + 无 cookie 的 `GET /` 应得 401、带 cookie 得 200。

### 停止

`dsh web` 进程先 `echo $$ > /tmp/dsh-web.pid`；优雅停止是向该 pid 发 SIGTERM（DSH 依次 dispose 插件后退出 0，`--kill-on-exit` 收尾）；兜底向 proot 进程发 SIGQUIT。manifest 明确记录了为什么：**proot 忽略 SIGTERM/SIGINT/SIGHUP，`Process.destroy()` 无效、`destroyForcibly()` 会孤儿化 node**——这是 proot 方案的关键运维知识。

### WebView 适配

`assets/web/dsh_web_phone.css/js/state.js` 注入 DSH 网页做手机端适配；原生界面另有「islands」机制：插件可在原生页面上以 island（内嵌网页岛）形式落座（`ui.json` 的 `plugins.seats` 决定 native / island / web / hidden）。

## 四、与 DSH 的边界

dsh-go 在「不改 DSH 源码」的边界外又走了半步，四种手段值得分开看：

1. **构建期打补丁**：`dshPatches: ["route-guard.diff"]`——rootfs 里的 DSH 被改过源码。这是本项目硬规则 1 明令禁止的做法（见 §七）。
2. **运行期覆盖**：`dsh web --patch /etc/dsh-app/dsh-web.patch.yml`。`--patch` 是 DSH 自己的 CLI 选项（覆盖配置而非改文件），auth 目录也用「额外 `--patch` 把文件按绝对路径插进宿主」的方式挂载。
3. **DSH 插件**（合规路线）：`assets/engine/auth/` 打包成 rootfs 内 `/opt/dsh-app/auth/` 的插件，经 `@deepseek-ai/dsh-typert-protocol` 的 `TypertRemoteService` 暴露 `appAuth` Remote 服务（`list/begin/poll/answer/cancel/signOut`），把 DSH 0.2.1 已有但无客户端入口的订阅登录（pi-ai 的 OAuth：`llm-pi-ai/openai-codex`=ChatGPT、`llm-pi-ai/anthropic`=Claude）做成轮询状态机给 App 用。授权 grant 仍由 `ctx.credentials` 落在 `~/.dsh/.credentials.yaml`（0600），token 刷新留在 pi-ai 侧。这两个 mjs 文件带 `SPDX-License-Identifier: MIT` 头。
4. **独立桥**：`dshGoBridge 0.1.0`，rootfs 内 `/opt/dsh-go/dsh-go-bridge`（闭源二进制/脚本，未在本次静态分析范围内展开）。

## 五、dsh-go-ui：让模型配置宿主原生界面

内置 skill `dsh-go-ui` 教 DSH 里的 agent 改 `$DSH_HOME/dsh-go/ui.json` 来调整 App 原生界面：顶栏按钮、输入框快捷胶囊、新对话建议卡、抽屉分组/排序、密度、隐藏元素、主题强调色、平板快捷键、插件落座。要点：

- **只能声明，不能执行**：无脚本、无网络、不能装东西；按钮只有四种动作——`send`（填入输入框、绝不自动发送）、`open`（打开 App 页面）、`command`（执行 `/命令`）、`link`（仅 https，弹确认后浏览器打开），且都要用户亲手点；
- 配套 `schema.json` + `check.mjs` 校验脚本 + `ui.status.json` 回读 App 实际生效结果，错误分级（错误/忽略/提示/整份失效），单项写错只影响单项，整份语法错误时 App 沿用上一份有效配置；
- 每台主机一份（App 连哪台 DSH 用哪台的），≤64KiB，skill 头部有 managed 标记行支持 App 托管更新。

这与本仓库 [Bot 视图](../plans/2026-10-20-widget-views.md)「固定组件目录的 JSON 蓝图」是同一思想在宿主界面维度的应用：声明式、带 schema、可校验、最小动作集。

## 六、安全与合规观察

- **权限激进**：`MANAGE_EXTERNAL_STORAGE`（全文件访问）、`REQUEST_INSTALL_PACKAGES`（自更新装 APK）、`SYSTEM_ALERT_WINDOW`（悬浮宠物/球）、`RECORD_AUDIO`、Shizuku 接口、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`（保活 proot 引擎）。targetSdk 28 明显偏低，大概率是为保留 legacy 外部存储与更少的运行时限制——Play 商店不会收，内测走微信侧载。
- **数据全在本机**：DSH 数据、`.credentials.yaml`（含 API key / OAuth grant）都在 App 私有目录的 rootfs 里；manifest 记录 rootfs 制作约束（符号链接全部相对且不逃逸、清 setuid/setgid、uid/gid 0、父目录先于子项排序）。
- **凭据面**：支持把 `DEEPSEEK_API_KEY` 经 `{GUEST_ENV}` 注入引擎；ChatGPT/Claude 订阅 grant 落 `.credentials.yaml`。
- 结论：设计上有安全意识（token 一次性认证、HttpOnly+Strict cookie、声明式 UI、rootfs 卫生约束、全链路哈希），但「自签名 + 高权限 + 低 targetSdk + 侧载内测」意味着应按社区第三方构建对待，登录什么账号、放什么密钥需自担风险。

## 七、对本仓库的参考价值与红线

### 可借鉴（格式与契约，不抄代码）

- **runtime manifest 的信息密度**：一份 JSON 记齐版本矩阵、rootfs 哈希与字节数、每个 so 的来源/补丁/哈希、启动 argv 模板与占位符语义、token 行正则、认证交换、健康检查、优雅/兜底停止、关键文件路径。阶段 D 若做安卓包，这份格式可以直接当 checklist。
- **proot 运维知识**：信号语义（SIGQUIT 兜底、destroy() 无效）、`/dev/shm` 与 selinux 占位、link2symlink、`resolv.conf` 处理——都是踩过坑的结论。
- **「pinned DSH + 自有数据目录 + 自有界面」的再验证**：与本仓库桌面应用（自有 `DSH_HOME`、锁版本、自有窗口）同构，且证明在手机上也成立、插件生态可以原样搬运。
- **dsh-go-ui 模式**：模型改宿主界面的声明式配置 + schema + 校验脚本 + 状态回读，可反哺 Bot 视图/桌面端将来的可配置界面。

### 不可采纳（与硬规则冲突）

- **构建期 patch DSH（route-guard.diff）**：违反硬规则 1「phase C 前绝不 patch DSH」。即便将来做移动端，也应走公开 API / 插件（其 auth 桥即合规示范），或在 phase C 之后用自有运行时解决。
- **照搬其文件/代码**：硬规则 3。其 rootfs 与 Flutter 代码许可未知（仅 auth 两个 mjs 标 MIT）；本文引用的概念与格式可以学，代码与素材不进本仓库。
- 另注意它锁 0.2.1-rc.2 而本仓库在 0.2.2；若验证插件在 dsh-go 上运行，版本差异需先核对 API 面。

## 变更

- 2026-10-25：建立，基于 0.9.0 内测版 APK 静态分析。

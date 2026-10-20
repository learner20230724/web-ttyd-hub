# 部署 / Deployment

按 README 安装依赖并构建。Hub 没有账号系统，终端以服务系统用户执行命令，生产环境使用专用普通用户和认证 HTTPS 代理。

## systemd（Linux，可选）

1. 创建专用用户，例如 `sudo useradd --system --create-home --shell /bin/bash ttydhub`。
2. 将项目安装到 `/opt/web-ttyd-hub`，为该用户提供读取权限和适当的可写工作目录，安装依赖并构建。
3. 检查 `deploy/web-ttyd-hub.service` 中路径与用户，将 `/usr/bin/node` 改为本机 Node 实际路径；确保服务 PATH 可找到 ttyd 和 tmux。
4. 将模板复制到 `/etc/systemd/system/web-ttyd-hub.service`，运行 `sudo systemctl daemon-reload` 和 `sudo systemctl enable --now web-ttyd-hub`。

模板使用 `KillMode=process`，只终止 Hub 主进程，由 Hub 清理 ttyd 和终端观察连接，保留 tmux 和其中的任务。已有部署应先检查停止策略，默认 `control-group` 会连同任务一起终止。此策略也意味着停止 Hub 后任务继续占用资源；彻底关闭任务应在归档中永久删除会话。会话 ID、名称和状态持久保存，Hub 重启会自动恢复入口并接续仍运行的 tmux；这不等于机器重启后恢复进程。`npm run deploy:web` 构建、重启并核对原 tmux PID 存活。

## Caddy HTTPS 与认证

安装 Caddy，将 `deploy/Caddyfile` 域名改为自己的域名，设置 DNS 并开放证书签发需要的 80/443 流量。交互生成密码散列：

```bash
caddy hash-password
```

将输出配置为 Caddy 进程的 `HUB_PASSWORD_HASH` 环境变量（受保护的 EnvironmentFile），或在本地私有配置中替换占位符。不要提交真实认证配置。

加载前执行 `caddy validate --config /path/to/Caddyfile --adapter caddyfile`。示例保护整个站点，包括 API、WebSocket 和终端路径。Hub 保持 `HOST=127.0.0.1`，不用公开 3000 或内部 ttyd 端口。

## 验证

本机 `curl http://127.0.0.1:3000/api/sessions` 应返回会话列表。公网未认证请求应返回 401；认证后检查创建、输入和重连。两个浏览器连接同一会话验证共享。按剪贴板指南在目标浏览器验证选择和粘贴。

These are templates. Verify DNS, TLS, authentication and clipboard behavior in your own environment.

## 本机缓存与差异传输

手机 APP 的 WebView、手机浏览器和电脑浏览器各自保存本机缓存，按站点来源和 Hub 挂载路径隔离。会话列表、上次选中项、必要的任务状态及排列以小容量元数据保存；回答、全文和电脑终端历史共用 IndexedDB 正文缓存，按估算 UTF-16 大小限制为 128 MiB，另有元数据开销，超限清理较早条目。列表元数据限 2 MiB。缓存只保存在当前设备，不另上传第三方云端；原有服务端会话、已读和排列同步照常进行。

重新打开先恢复本地列表与正文，再联网验证当前会话 ID 和 `createdAt`，之后补齐状态和内容。缓存显示期间不把旧完成状态当作新的实时确认，也不凭旧元数据连接或向同名新会话发送输入。存储不可用、超时或损坏时回退网络读取。清理网站数据、APP 数据、浏览器自动回收或缓存超过容量后，需重新下载相应历史；缓存不增加服务端历史保留范围，也不能替代服务器备份。

手机回答、全文及历史接口仍使用 `Cache-Control: no-store`；持久副本由应用自己管理，不能交给共享 HTTP 缓存。客户端带已有强 ETag 验证，无变化返回 304。请求携带 `X-TTYD-Delta: fields-v1` 时，服务端可按顶层字段返回 JSON 差异，分别更新纯文本、ANSI 和对话数组；客户端核对基线、范围、目标字段顺序与完整内容 SHA256 后才保存。`X-TTYD-Generation` 可选请求头与 `createdAt` 不符时，读取前或读取过程中均返回 409，旧身份不会收到替代会话的正文。服务端差异基线按会话、创建时间、视图和凭据隔离，最多 16 MiB、64 个范围、每范围 4 个版本，10 分钟未使用后失效；基线丢失、补丁较大或校验失败时回退完整响应。

`tests/content-cache-browser.cjs` 使用正式客户端与真实 HTTP 服务，合成 1200 行终端历史：首次正文 122,264 字节，关闭页面再打开后携带磁盘 ETag，未变化时 304 正文为 0 字节；追加 Unicode／ANSI 输出时，完整正文为 122,369 字节，实际差异响应为 483 字节，减少 99.61%。实验还篡改结构合法的差异正文，确认客户端校验失败后只重试一次无条件完整读取，不把损坏内容保存到磁盘。数字仅指未压缩 HTTP 正文，不包括请求头、状态同步、静态资源等流量，不是实际用户使用统计。

电脑终端先恢复本地快照和已保存输出，再用当前基线重连，历史没变时复用缓存，有少量新增输出时接收差异。合成终端重连实验约减少 95% 的初始恢复传输量；这不是实际用户流量统计，完全重绘、历史截断和缓存失效时可能需要完整快照。键盘输入和终端查询回复只在实时连接与身份验证完成后启用，缓存重放不会向终端发送数据。已读还须等待对应完成轮次的权威快照渲染结束且视口位于底部；仅加载脚本、恢复选中项或显示旧缓存不会清除新回复提醒。

前端静态资源仍先经过原有认证。实际存在的 `/assets/` 构建文件若名称含至少 8 位内容 hash，返回 `private, max-age=31536000, immutable`；HTML 与未带 hash 的静态文件返回 `private, no-cache`，通过 ETag／Last-Modified 重新验证。HTML 更新后会引用新的文件名，常规发布不要求用户清除浏览器缓存。API、终端代理和读取错误继续禁止 HTTP 缓存，缺失资源回退的 HTML 不会被当作永久版本资源保存。保持代理对全部路径的认证，不要为了资源缓存跳过登录。

`npm run deploy:web` 会在 Vite 清空旧输出前，用 `scripts/retain-web-assets.cjs` 暂存近期带 hash 的构建资源，构建成功后并回新输出，再按原流程备份会话和重启服务。这样已打开的旧页面稍后懒加载旧版终端组件时，仍能取得对应 JavaScript／CSS。新构建的同名文件始终优先且全部保留；额外旧资源限最近 7 天、最多 32 MiB，按原文件时间优先保留较新的版本，复制不会刷新过期时间。不保留 HTML、未带 hash 的文件或软链接。超过保留窗口的旧页面需重新加载。

新输出、发送消息、命令和状态同步仍需联网。当前 HTTP 入口没有 Service Worker，资源缓存不代表完全断网时能冷启动整个网页；页面已加载时可以读取已保存正文。更新仍执行 `npm run deploy:web`，不需为网页缓存功能重打 APK。

检查：`node --test tests/content-delta.test.js tests/frontend-cache.test.js tests/retain-web-assets.test.js`、构建后的 `node tests/content-cache-browser.cjs`、`node tests/mobile-local-cache-browser.cjs`、`node tests/session-metadata-browser.cjs` 与 `node tests/terminal-cache-browser.cjs`。测试使用合成会话，覆盖缓存优先、差异传输、生成代替换、存储故障、认证、资源重新验证和发布时旧 hash 资源的保留边界，不等于 M153 真机验证。

## 跨设备会话状态

`GET /api/sessions` 同时返回 `shared`（递增版本、逐轮已读标记、置顶和排列），禁止缓存。`POST /api/sessions/sync` 接受 `read`、`pin`、`move` 或首次 `initialize` 操作，沿用站点认证；不接受设备用整个旧快照覆盖服务器。操作核对会话 ID 与 `createdAt`，已读还核对当前成功完成的轮次。保存成功后 `session:sync` 广播完整共享状态，前端按递增版本直接应用。WebSocket 建立时发送 `session:snapshot`，补齐重连期间的变化；旧客户端仍可通过原有列表接口核对。手机回前台替换旧列表请求、重建可能半断开的 WebSocket，并重试挂起的同步操作，定时核对继续作为断线补偿。

共享数据随原 `data/sessions.json` 原子保存和备份，旧版状态文件可直接升级。Hub 没有独立用户账号，同一 Hub 的所有获准访问设备共享这些状态。首次连接导入相符的旧本机已读记录，仅首次初始化排列，后续设备以服务器为准；当前会话选择、输入草稿和阅读设置仍保留在设备上。无需更新 APK，运行原有 `npm run deploy:web`，网页刷新或 APP 重新加载后生效。

验证：`npm test`、`npm run build`、`node tests/session-sync-browser.cjs`。后者使用独立手机／桌面浏览器上下文及合成内容，检查双向已读、各任务阶段、置顶排序、断线／刷新重试、过期已读拒绝和归档恢复；不读取生产会话，也不等于 M153 真机测试。

### 状态与手机阅读的对照检查

完成状态来自服务端当前轮次，已读来自用户实际看到的内容，缓存只负责加快读取。`session:activity` 已带完整任务状态，前端直接应用；不再为每条通知重复请求整个列表。重连、前台恢复和每 5 秒的列表核对继续补偿漏通知；较早发起的列表响应不能覆盖随后收到的新状态。

手机内容响应携带 `completed`，并参与内容 ETag。只有与当前完成轮次相符的内容已渲染、阅读区可见且位于最新内容时，才提交已读；仅选中会话、查看缓存旧回复或展开列表不会提前清除绿色提醒。Linux 与 Windows 的全文快照都在捕获前记录轮次，避免把捕获过程中产生的新完成状态算进旧画面。

先读取内存或 IndexedDB 中的当前视图，立即显示已有内容，再带缓存版本向服务端核对。磁盘打开与读取都有 500 毫秒上限，网络仅给快速磁盘读取最多 75 毫秒来提供 ETag，缓存异常时继续网络，迟到的磁盘读取不能覆盖新网络内容。切换使用现有缓存立即显示，另一视图只预读本地缓存，保留两种视图的阅读位置和草稿；未点开的全文不提前下载。完成会话每 15 秒核对正文，工作中、来源初始化或消息确认中保持快速核对，状态改变、回前台或恢复联网立即更新。

构建后运行 `node tests/mobile-state-browser.cjs`，通过二十组控制变量实验核对：后台完成、列表挂起、漏通知、IndexedDB 挂起、正文挂起、阅读旧内容、缓存切换、提取中断、旧磁盘缓存、完成／前台／切换时替换旧正文请求，以及前台和联网时替换旧列表、列表被阻塞时直接应用远端已读和置顶。包含长标题与项目子目录的发现、最终回复显示、完成状态、真正空会话及来源临时中断后的阅读切换。实验使用正式路由及 `SessionManager.mobile`，不调用输入接口。

回答与全文的区分同时经过真实 `CodexActivity` 读取合成 rollout：故意令终端画面抓取失败，仍须提取最终回复、识别完成，并让回答排除命令日志、全文保留日志。异步问题回复只提取用户回答，测试确认内部 JSON 和问题编号不会进入对话正文。画面抓取只补充操作等待／重试状态，失败不能否定已验证的任务记录；成功完成后无需重复抓画面。首次缺少对话时，`CodexActivity.ready()` 共用最多 4 秒的初始化等待，就绪、超时或关闭均清理资源，全文不等待。已验证来源但暂无消息时返回 `messages: []`，不混入终端欢迎画面。

保留原来的单个切换按钮，每次点击直接切换并保存选择。Codex 回答区域只显示结构化对话，来源初始化时在正文显示读取状态并提供全文入口，自动继续读取；已取得的回复在临时中断时保留，但不会拿旧内容确认新一轮已读。普通 Shell 继续显示原始输出。`node tests/mobile-cold-start-browser.cjs` 覆盖空缓存、旧全文缓存、首次后台启动／返回前台、较长来源中断、同名会话重建；全程不依赖用户发送消息。

`node tests/codex-cold-start-integration.cjs` 使用真实 Codex 0.163.0、私有 tmux 与临时合成模型：恢复历史、首次立即读取、较慢初始化超时后的后台自然恢复，确认无需新增模型输入。4 秒是单次等待上限，不是所有设备的初始化速度承诺。`node tests/mobile-command-integration.cjs` 则经过实际 `SessionManager.input/history` 验证 tmux 粘贴、斜杠命令、方向键、回车、ESC 和仅输入。两者已加入 Linux CI；浏览器回归在 Linux／Windows CI 运行。

本地命令只确认终端送达，普通提问仍需匹配接收记录。发送请求从响应头到 JSON 正文均有 10 秒确认期限，超时保留草稿与结果未确认的信息，不自动重发，也不让内容轮询清除该信息。普通提问的错误合并在对应发送卡片中。方法来源、按步骤的结果与合成截图见 [手机体验检查](ux-audit-2026-10-20.md)。

`node tests/session-sync-browser.cjs` 使用两个独立浏览器上下文，在电脑列表响应被暂扣时从手机实际读取回复，验证通知仍及时清除电脑未读状态，迟到的旧列表不能回滚。另测多端任务阶段、置顶排序、离线恢复、已读请求重试和草稿保留。`node tests/codex-questions-integration.cjs` 使用本机真实 Codex 和临时合成模型端点，核对最终回复与完成状态在追加任何消息前即可读取。这些检查不等于 M153 真机验证。

## Codex 状态兼容检查

Linux 的 Codex 0.162.1 可将任务交给共享 app-server daemon。服务需要 `ss`（iproute2）、Node.js 22.13+ 的 `node:sqlite`，以及读取相同服务用户 `/proc` 和 Codex 状态库的权限。独立进程继续直接读取其主任务 rollout。共享后台仅在当前终端标题、项目名与后台打开的主任务唯一匹配时关联。匹配遵循 Codex 的显示规则：任务名最多 48 个字素、项目名最多 24 个字素，超出时保留前 45／21 个字素并附加 `...`；项目名优先使用 Git 根目录（包括 worktree），其次使用项目配置目录，最后使用工作目录。相同截短标题仍视为歧义，不能任选一个会话。读取失败或身份不明确时保留原先的中性「已连接」，不把它显示为需用户处理的「状态待确认」，也不推断任务已经完成。不扫描其他对话来猜当前任务，不改 Codex 全局配置。Windows 共享后台尚未验证。

等待操作时的 `[ ! ] Action Required |` 与 `[ . ] Action Required |` 是 [Codex 0.162.1 的闪烁标题前缀](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/status_surfaces.rs)。匹配兼容两种前缀，同时保留原样标题的候选，原样与去前缀后若对应不同任务仍拒绝关联。只归一化这两个已知前缀，不按任意标题后缀匹配；任务阶段和成功完成仍由原有事件规则确定。

发布检查：`npm test`、`node tests/activity-browser.cjs`、`node tests/mobile-input-browser.cjs`；浏览器检查须先 `npm run build`，测试使用合成消息，不读取私人会话。`node tests/terminal-browser.cjs` 验证电脑终端滚动、重连和手机阅读没有回归。最后执行 `npm run deploy:web` 并核对当前会话的 busy / phase / completed。本轮成功的完成事件才设置 completed；未知状态、中断和出错均不沿用上一轮绿色提醒。

状态语义参考 [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 turn 结束与线程活动状态；rollout 与终端标题属于版本相关适配，升级后仍需回归验证。

## 账号额度与追问接口

`GET /api/sessions/codex-usage` 通过本机 `codex app-server --stdio` 的 `account/rateLimits/read` 读取服务用户账号额度，60 秒缓存、并发合并，手动刷新最短间隔 5 秒。Linux 使用与终端相同的交互 Bash 环境加载用户既有代理设置，不改全局服务配置。不读写 OAuth 文件，不返回邮箱、凭据、Credits 余额或 Token 统计。服务用户、HOME / CODEX_HOME 与 Codex 登录环境须一致；保持原站点认证覆盖此接口。首次初始化和额度读取分别最多 20 秒，浏览器最多等待 45 秒，不触发自动登录。

`GET /api/sessions/:name/questions` 只关联实时验证的 tmux → Codex 客户端 → 共享 daemon socket → 主线程，使用本机 Unix WebSocket 初始化并 `thread/resume` 订阅既有线程（不发起新 turn）。挂起的 `item/tool/requestUserInput` 会重放；`POST /api/sessions/:name/questions/:id/respond` 提交时再次核对当前终端身份，只回应服务端提供的随机请求标识。答案或空答案（跳过）通过原请求 ID 回送，并等待 `serverRequest/resolved` 确认；不会调用 `turn/interrupt`。仅此明确的提问请求可响应，不提供任意 RPC 转发、命令或审批自动确认。读写均沿用原有访问控制和 `no-store`，追问与草稿不持久化。

检查：`node --test --test-concurrency=1 tests/*.test.js`；构建后运行 `node tests/codex-mobile-browser.cjs`、`node tests/activity-browser.cjs` 和 `node tests/mobile-input-browser.cjs`。Linux 本机有 Codex 时可运行 `node tests/codex-questions-integration.cjs`：临时 CODEX_HOME + 本地合成 Responses 服务 + 真实 app-server，验证重放、中文回答、空答案跳过和终端同步，不调用真实模型、不读取生产会话或凭据。接口依据同上 OpenAI App Server 文档，升级 Codex 后回归验证。

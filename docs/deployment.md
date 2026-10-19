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

## 跨设备会话状态

`GET /api/sessions` 同时返回 `shared`（递增版本、逐轮已读标记、置顶和排列），禁止缓存。`POST /api/sessions/sync` 接受 `read`、`pin`、`move` 或首次 `initialize` 操作，沿用站点认证；不接受设备用整个旧快照覆盖服务器。操作核对会话 ID 与 `createdAt`，已读还核对当前成功完成的轮次。保存成功后 `session:sync` 广播完整共享状态，前端按递增版本直接应用。WebSocket 建立时发送 `session:snapshot`，补齐重连期间的变化；旧客户端仍可通过原有列表接口核对。手机回前台替换旧列表请求、重建可能半断开的 WebSocket，并重试挂起的同步操作，定时核对继续作为断线补偿。

共享数据随原 `data/sessions.json` 原子保存和备份，旧版状态文件可直接升级。Hub 没有独立用户账号，同一 Hub 的所有获准访问设备共享这些状态。首次连接导入相符的旧本机已读记录，仅首次初始化排列，后续设备以服务器为准；当前会话选择、输入草稿和阅读设置仍保留在设备上。无需更新 APK，运行原有 `npm run deploy:web`，网页刷新或 APP 重新加载后生效。

验证：`npm test`、`npm run build`、`node tests/session-sync-browser.cjs`。后者使用独立手机／桌面浏览器上下文及合成内容，检查双向已读、各任务阶段、置顶排序、断线／刷新重试、过期已读拒绝和归档恢复；不读取生产会话，也不等于 M153 真机测试。

### 状态与手机阅读的对照检查

完成状态来自服务端当前轮次，已读来自用户实际看到的内容，缓存只负责加快读取。`session:activity` 已带完整任务状态，前端直接应用；不再为每条通知重复请求整个列表。重连、前台恢复和每 5 秒的列表核对继续补偿漏通知；较早发起的列表响应不能覆盖随后收到的新状态。

手机内容响应携带 `completed`，并参与内容 ETag。只有与当前完成轮次相符的内容已渲染、阅读区可见且位于最新内容时，才提交已读；仅选中会话、查看缓存旧回复或展开列表不会提前清除绿色提醒。Linux 与 Windows 的全文快照都在捕获前记录轮次，避免把捕获过程中产生的新完成状态算进旧画面。

网络请求独立于 IndexedDB，磁盘打开与读取都有 500 毫秒上限，缓存异常时使用内存和网络。切换使用现有缓存立即显示，只预读必要的另一视图，保留两种视图的阅读位置和草稿。磁盘缓存不会成为网络或切换的前置条件。

构建后运行 `node tests/mobile-state-browser.cjs`，通过十七组控制变量实验核对：后台完成、列表挂起、漏通知、IndexedDB 挂起、正文挂起、阅读旧内容、缓存切换、提取中断、旧磁盘缓存、完成／前台／切换时替换旧正文请求，以及前台和联网时替换旧列表、列表被阻塞时直接应用远端已读和置顶。实验使用正式路由及 `SessionManager.mobile`，不调用输入接口。

回答与全文的区分同时经过真实 `CodexActivity` 读取合成 rollout：故意令终端画面抓取失败，仍须提取最终回复、识别完成，并让回答排除命令日志、全文保留日志。画面抓取只补充操作等待／重试状态，失败不能否定已验证的任务记录；成功完成后无需重复抓画面。初次读取回答会等待正在进行的发现任务，避免过早回退。保留原来的单个切换按钮；真正无法提取对话时保持终端可读，按钮显示实际的「全文」，点击可重试，恢复后自动回到回答，不增加提示行或覆盖阅读偏好。

`node tests/session-sync-browser.cjs` 使用两个独立浏览器上下文，在电脑列表响应被暂扣时从手机实际读取回复，验证通知仍及时清除电脑未读状态，迟到的旧列表不能回滚。另测多端任务阶段、置顶排序、离线恢复、已读请求重试和草稿保留。`node tests/codex-questions-integration.cjs` 使用本机真实 Codex 和临时合成模型端点，核对最终回复与完成状态在追加任何消息前即可读取。这些检查不等于 M153 真机验证。

## Codex 状态兼容检查

Linux 的 Codex 0.162.1 可将任务交给共享 app-server daemon。服务需要 `ss`（iproute2）、Node.js 22.13+ 的 `node:sqlite`，以及读取相同服务用户 `/proc` 和 Codex 状态库的权限。独立进程继续直接读取其主任务 rollout。共享后台仅在当前完整终端标题、项目名与后台打开的主任务唯一匹配时关联；遇到自定义标题、重名或读取失败会显示「状态待确认」。不扫描其他对话来猜当前任务，不改 Codex 全局配置。Windows 共享后台尚未验证。

等待操作时的 `[ ! ] Action Required |` 与 `[ . ] Action Required |` 是 [Codex 0.162.1 的闪烁标题前缀](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/status_surfaces.rs)。匹配兼容两种前缀，同时保留原样标题的候选，原样与去前缀后若对应不同任务仍拒绝关联。只归一化这两个已知前缀，不按任意标题后缀匹配；任务阶段和成功完成仍由原有事件规则确定。

发布检查：`npm test`、`node tests/activity-browser.cjs`、`node tests/mobile-input-browser.cjs`；浏览器检查须先 `npm run build`，测试使用合成消息，不读取私人会话。`node tests/terminal-browser.cjs` 验证电脑终端滚动、重连和手机阅读没有回归。最后执行 `npm run deploy:web` 并核对当前会话的 busy / phase / completed。本轮成功的完成事件才设置 completed；未知状态、中断和出错均不沿用上一轮绿色提醒。

状态语义参考 [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 turn 结束与线程活动状态；rollout 与终端标题属于版本相关适配，升级后仍需回归验证。

## 账号额度与追问接口

`GET /api/sessions/codex-usage` 通过本机 `codex app-server --stdio` 的 `account/rateLimits/read` 读取服务用户账号额度，60 秒缓存、并发合并，手动刷新最短间隔 5 秒。Linux 使用与终端相同的交互 Bash 环境加载用户既有代理设置，不改全局服务配置。不读写 OAuth 文件，不返回邮箱、凭据、Credits 余额或 Token 统计。服务用户、HOME / CODEX_HOME 与 Codex 登录环境须一致；保持原站点认证覆盖此接口。首次初始化和额度读取分别最多 20 秒，浏览器最多等待 45 秒，不触发自动登录。

`GET /api/sessions/:name/questions` 只关联实时验证的 tmux → Codex 客户端 → 共享 daemon socket → 主线程，使用本机 Unix WebSocket 初始化并 `thread/resume` 订阅既有线程（不发起新 turn）。挂起的 `item/tool/requestUserInput` 会重放；`POST /api/sessions/:name/questions/:id/respond` 提交时再次核对当前终端身份，只回应服务端提供的随机请求标识。答案或空答案（跳过）通过原请求 ID 回送，并等待 `serverRequest/resolved` 确认；不会调用 `turn/interrupt`。仅此明确的提问请求可响应，不提供任意 RPC 转发、命令或审批自动确认。读写均沿用原有访问控制和 `no-store`，追问与草稿不持久化。

检查：`node --test --test-concurrency=1 tests/*.test.js`；构建后运行 `node tests/codex-mobile-browser.cjs`、`node tests/activity-browser.cjs` 和 `node tests/mobile-input-browser.cjs`。Linux 本机有 Codex 时可运行 `node tests/codex-questions-integration.cjs`：临时 CODEX_HOME + 本地合成 Responses 服务 + 真实 app-server，验证重放、中文回答、空答案跳过和终端同步，不调用真实模型、不读取生产会话或凭据。接口依据同上 OpenAI App Server 文档，升级 Codex 后回归验证。

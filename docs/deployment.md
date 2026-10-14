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

## Codex 状态兼容检查

Linux 的 Codex 0.162.1 可将任务交给共享 app-server daemon。服务需要 `ss`（iproute2）、Node.js 22.13+ 的 `node:sqlite`，以及读取相同服务用户 `/proc` 和 Codex 状态库的权限。独立进程继续直接读取其主任务 rollout。共享后台仅在当前完整终端标题、项目名与后台打开的主任务唯一匹配时关联；遇到自定义标题、重名或读取失败会显示「状态待确认」。不扫描其他对话来猜当前任务，不改 Codex 全局配置。Windows 共享后台尚未验证。

发布检查：`npm test`、`node tests/activity-browser.cjs`、`node tests/mobile-input-browser.cjs`；浏览器检查须先 `npm run build`，测试使用合成消息，不读取私人会话。`node tests/terminal-browser.cjs` 验证电脑终端滚动、重连和手机阅读没有回归。最后执行 `npm run deploy:web` 并核对当前会话的 busy / phase / completed。本轮成功的完成事件才设置 completed；未知状态、中断和出错均不沿用上一轮绿色提醒。

状态语义参考 [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 turn 结束与线程活动状态；rollout 与终端标题属于版本相关适配，升级后仍需回归验证。

## 账号额度与追问接口

`GET /api/sessions/codex-usage` 通过本机 `codex app-server --stdio` 的 `account/rateLimits/read` 读取服务用户账号额度，60 秒缓存、并发合并，手动刷新最短间隔 5 秒。Linux 使用与终端相同的交互 Bash 环境加载用户既有代理设置，不改全局服务配置。不读写 OAuth 文件，不返回邮箱、凭据、Credits 余额或 Token 统计。服务用户、HOME / CODEX_HOME 与 Codex 登录环境须一致；保持原站点认证覆盖此接口。首次初始化和额度读取分别最多 20 秒，浏览器最多等待 45 秒，不触发自动登录。

`GET /api/sessions/:name/questions` 只关联实时验证的 tmux → Codex 客户端 → 共享 daemon socket → 主线程，使用本机 Unix WebSocket 初始化并 `thread/resume` 订阅既有线程（不发起新 turn）。挂起的 `item/tool/requestUserInput` 会重放；`POST /api/sessions/:name/questions/:id/respond` 提交时再次核对当前终端身份，只回应服务端提供的随机请求标识。答案或空答案（跳过）通过原请求 ID 回送，并等待 `serverRequest/resolved` 确认；不会调用 `turn/interrupt`。仅此明确的提问请求可响应，不提供任意 RPC 转发、命令或审批自动确认。读写均沿用原有访问控制和 `no-store`，追问与草稿不持久化。

检查：`node --test --test-concurrency=1 tests/*.test.js`；构建后运行 `node tests/codex-mobile-browser.cjs`、`node tests/activity-browser.cjs` 和 `node tests/mobile-input-browser.cjs`。Linux 本机有 Codex 时可运行 `node tests/codex-questions-integration.cjs`：临时 CODEX_HOME + 本地合成 Responses 服务 + 真实 app-server，验证重放、中文回答、空答案跳过和终端同步，不调用真实模型、不读取生产会话或凭据。接口依据同上 OpenAI App Server 文档，升级 Codex 后回归验证。

# 部署 / Deployment

按 README 安装依赖并构建。Hub 没有账号系统，终端以服务系统用户执行命令，生产环境使用专用普通用户和认证 HTTPS 代理。

## systemd（Linux，可选）

1. 创建专用用户，例如 `sudo useradd --system --create-home --shell /bin/bash ttydhub`。
2. 将项目安装到 `/opt/web-ttyd-hub`，为该用户提供读取权限和适当的可写工作目录，安装依赖并构建。
3. 检查 `deploy/web-ttyd-hub.service` 中路径与用户，将 `/usr/bin/node` 改为本机 Node 实际路径；确保服务 PATH 可找到 ttyd 和 tmux。
4. 将模板复制到 `/etc/systemd/system/web-ttyd-hub.service`，运行 `sudo systemctl daemon-reload` 和 `sudo systemctl enable --now web-ttyd-hub`。

模板使用 `KillMode=process`，只终止 Hub 主进程，由 Hub 清理 ttyd，保留 tmux 和其中的任务。已有部署应先检查停止策略，默认 `control-group` 会连同任务一起终止。此策略也意味着停止 Hub 后任务继续占用资源；彻底关闭任务应先在界面删除会话。Hub 会话列表仍在内存中，重启后需要用原内部 ID 重新建立入口，不等于机器重启恢复。

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

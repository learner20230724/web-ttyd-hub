# Web TTYd Hub · 随时接着干的浏览器终端

[English](README_EN.md) · [复制粘贴指南](docs/clipboard.md) · [部署指南](docs/deployment.md) · [AI 可读摘要](llms.txt)

**电脑开工，手机接手。关掉网页，任务继续。**

基于 **ttyd + tmux** 的自托管 Web 终端会话管理器：在浏览器中创建、切换、停止和重连多个终端，让远程开发、日志排查和命令行 AI 编程工具随手可用。本仓库是 [sosopop/web-ttyd-hub](https://github.com/sosopop/web-ttyd-hub) 的改进版，使用官方 ttyd，无需修改 ttyd 内核。

![Web TTYd Hub 多会话终端界面](assets/72643b69-16e1-44ab-841f-cc1dee1b1c0b.png)

## 解决什么痛点？

| 你遇到的问题 | 这里的处理方式 |
| --- | --- |
| 多终端要记不同端口、手动启动进程 | 网页创建命名会话，侧栏切换，统一 HTTP / WebSocket 入口 |
| 关网页后担心长任务断掉 | tmux 承载任务，浏览器断开后可重新连接 |
| 手机与电脑之间来回切换 | 响应式页面，同一会话可从多个浏览器访问 |
| 拖选被 tmux 抢走，复制日志很费劲 | 可选关闭 tmux 鼠标捕获的配置与复制粘贴排查指南 |
| 输出太多，难找之前的日志 | ttyd 浏览器回滚 10,000 行；可选 tmux 历史 20,000 行 |
| 调整窗口时提示干扰操作 | 关闭 ttyd 离开确认与尺寸浮层 |
| 部署需要重新拼配置 | 提供回环监听、Caddy HTTPS/认证与 systemd 示例 |

## 和官方 ttyd、上游 Hub 的关系

[官方 ttyd](https://github.com/tsl0922/ttyd) 提供浏览器终端能力，tmux 提供会话保活。上游 Hub 已提供 Vue 管理界面、多会话、Shell 选择和统一代理。

本改进版补充 **ttyd 仅监听回环地址、10,000 行回滚、减少提示干扰、可选 tmux 复制配置，以及部署和故障排查文档**。复制粘贴依赖 ttyd/xterm.js 与浏览器能力，未新增独立剪贴板引擎或一键复制按钮。

## 中文名称与重命名

创建时可输入中文、空格和常见符号，例如「项目开发」「日志排查 第二轮」。名称去除首尾空格，长度为 1–80 个字符，不接受重复名称或控制字符；留空自动命名。

在侧栏点击会话右侧的 **✎**，输入新名称并保存；支持 Enter 保存、Esc 取消，中文输入法选词回车不会触发保存。运行中和已停止的会话都可以改名。显示名称与内部 ID 分离，重命名不会重建终端或中断任务，其他浏览器同步显示新名称。

API：`POST /api/sessions` 的 `name` 是显示名称；响应 `name` 是稳定内部 ID，`displayName` 是界面名称。`PATCH /api/sessions/:name` 使用稳定 ID 寻址，请求体为 `{"name":"新的中文名称"}`。旧 ASCII 会话 ID 保持兼容。显示名称与会话列表一样暂存内存，Hub 重启后不自动恢复；重新接续 tmux 时使用内部 ID。

验证：`npm test`（需要 ttyd 和 tmux）以及 `npm run build`。

## 复制粘贴：把容易踩的坑讲明白

- **复制**：拖选终端文字，使用浏览器复制菜单或系统快捷键。Windows/Linux 常用 `Ctrl+Shift+C`，macOS 常用 `⌘C`，取决于浏览器。
- **粘贴**：先点进终端，再用 `Ctrl+Shift+V`、`⌘V` 或浏览器粘贴菜单。`Ctrl+C` 无选区时通常是中断任务。
- **选不中**：检查 tmux 鼠标捕获；可选配置使用 `set -g mouse off`。应用自身开启鼠标模式时，桌面浏览器可尝试按住 Shift 拖选。
- **手机与权限**：长按菜单、软键盘和剪贴板权限受浏览器限制，不承诺所有机型表现一致。公网部署使用 HTTPS。

完整操作与历史输出说明见 [复制粘贴指南](docs/clipboard.md)。

## 快速开始

需要 **Node.js 22.12+、npm、ttyd（支持 `-W`）、tmux**，Linux 或 macOS。Windows 可使用 WSL，原生 Windows 未验证。

```bash
# Ubuntu / Debian；macOS 使用 brew install ttyd tmux
sudo apt install ttyd tmux
git clone https://github.com/learner20230724/web-ttyd-hub.git
cd web-ttyd-hub
npm ci --include=dev
npm ci --prefix frontend --include=dev
cp .env.example .env
npm run build
npm start
```

打开 `http://localhost:3000`，创建第一个会话。示例只允许本机访问，远程使用见 [部署指南](docs/deployment.md)。开发运行 `npm run dev`，前端端口 5173，后端 3000。

## 配置

通过 `.env` 或进程环境变量设置：

| 变量 | 程序默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Hub 监听地址；示例设为 `127.0.0.1` |
| `PORT` | `3000` | 网页与 API 端口 |
| `TTYD_PORT_RANGE_START` | `7681` | 内部 ttyd 端口起点 |
| `TTYD_PORT_RANGE_END` | `7780` | 内部 ttyd 端口终点 |

## 使用边界

- 浏览器断开后保活**不等于机器重启后恢复**。会话列表在内存中，Hub 重启不自动恢复列表；仍存活的 tmux 会话可用原名重新创建入口。
- 停止会话会停止 ttyd 接入进程；删除会话会终止对应 tmux 会话和任务。
- 多浏览器共享同一操作环境，**没有内置账号系统、用户隔离或细粒度权限**。访问者拥有服务系统用户的权限；对外开放须配置认证和 HTTPS。
- 浏览器回滚与 tmux 历史是两套机制。机器重启、进程退出或 systemd 清理都可能终止任务。

## 给搜索引擎与 AI 阅读器

项目类型：开源自托管浏览器终端 / Web terminal session manager。技术：ttyd、tmux、Node.js、Express、Vue 3、Vite、WebSocket。场景：远程命令行、多会话运维、手机终端、长任务接续、命令行 AI 编程工具。事实摘要：[llms.txt](llms.txt)。公开文档便于抓取，不保证被搜索引擎或 AI 收录、推荐。

## 许可证与致谢

遵循上游 README 声明的 MIT 许可，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。感谢 sosopop、ttyd、tmux 及其他依赖维护者。此项目不代表 ttyd 官方。

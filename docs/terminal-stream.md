# 桌面终端：本地滚动，服务器保活

桌面使用 xterm.js 6 和 tmux 3.4 的 control mode。连接路径是同源、沿用整站认证的 `/ws/terminal/:name`。手机回答/全文接口及原 `/terminal/:name` ttyd 入口保持兼容。

## 数据路径

1. 浏览器发送可用行列数，服务端确认会话运行并连接已有 tmux。不会重新启动 Codex，也不修改 Codex 启动命令、代理或全局 tmux 配置。
2. 同一控制连接捕获最多 20,000 行历史、当前屏幕、备用屏幕与光标/输入模式。捕获命令的最后一个响应形成历史与实时输出之间的边界。
3. 浏览器恢复真正的终端缓冲，随后接收活动窗格的原始 PTY 字节；不轮询全文，不叠加 HTML 历史面板。八进制转义先按字节解码，避免损坏跨消息的 UTF-8。
4. 滚动和选区只存在于当前浏览器。tmux 不进入 copy mode，不向其他观察者广播浏览器的滚动位置。上翻期间继续接收新内容；打字、粘贴回到底部。
5. 按键按十六进制字节通过 `send-keys -H` 发送。粘贴用独立临时 buffer 和 `paste-buffer -p -d`，以 tmux 知道的实际括号粘贴状态为准；不添加回车。客户端没有任意 tmux 命令接口。
6. tmux 已处理的光标位置、设备属性和颜色查询不由浏览器重复回答。渲染队列将大段写入与重连/尺寸变化时的重置串行执行。
7. WebSocket 心跳清理断开的观察者，输入/输出有大小限制；过慢的浏览器断开重连，不暂停生产输出的任务。离线时禁用输入并提示重连。关闭浏览器只分离控制客户端，不杀死窗格进程。

## 边界

- 这是活动窗格的终端，不是整个 tmux 状态栏/窗格布局的镜像。需要管理 tmux 布局或使用其前缀快捷键时，可使用 SSH 或兼容 ttyd 入口。
- 正常屏幕有浏览器回滚；全屏编辑器等保留自己的备用屏幕和鼠标协议，退出后恢复正常屏幕。应用本身的编辑/导航状态与 PTY 尺寸仍然共享，多个桌面的尺寸按 tmux 现有策略处理。手机阅读界面不参与尺寸协商。
- 无法恢复 tmux 已丢弃、应用覆盖或未保留的输出；服务端实际历史上限仍由 tmux 配置决定。20,000 行是请求/浏览器上限，不是无限日志存档。
- 网页变化无需新 APK。重新加载网页或重新打开 APP 即可获取线上资源。

## 验证与发布

```bash
npm ci --include=dev
npm --prefix frontend ci --include=dev
npm test
# 构建到隔离目录，避免测试构建覆盖正在服务的网页。
npm --prefix frontend run build -- --outDir /tmp/hub-terminal-build
npx playwright install chromium
HUB_PUBLIC_DIR=/tmp/hub-terminal-build npm run test:terminal
# 测试后发布；检查 KillMode=process，并验证原 tmux PID 保留。
npm run deploy:web
```

测试使用私有 `TMUX_TMPDIR` 和合成终端内容，不连接真实用户会话。覆盖独立双窗口滚动、滚轮不注入按键、持续输出期间阅读位置、ANSI 颜色、中文 IME、复制、多行与大段粘贴、跨站连接拒绝、畸形消息、重连时输出不丢失/不重复、备用屏幕恢复、手机阅读界面和进程存活。浏览器测试需要 Playwright Chromium 的系统依赖；M153 真机不在此自动化测试范围内。

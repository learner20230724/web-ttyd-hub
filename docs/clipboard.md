# 复制粘贴与历史输出 / Clipboard and scrollback

## Desktop

Click inside the terminal before pasting. Select text and use the browser Copy action. Common shortcuts: Ctrl+Shift+C / Ctrl+Shift+V (Windows/Linux), Cmd+C / Cmd+V (macOS). Browser and OS shortcuts differ. Ctrl+C without a selection normally interrupts the running program. This fork has no custom copy button or clipboard synchronization service.

## tmux 鼠标抢占

以运行 Hub 的同一系统用户执行：

```bash
tmux source-file /path/to/web-ttyd-hub/deploy/tmux.conf
```

如果提示没有 tmux server，先创建一个 Hub 会话。将示例三条设置合并到该用户的 `~/.tmux.conf` 可在以后启动时加载，不要覆盖已有配置。这是用户级设置，会影响该用户其他 tmux 会话；需要 tmux 鼠标操作时可以不应用。

- `mouse off`：避免 tmux 捕获拖选。应用自身启用鼠标时，可尝试 Shift+拖选，具体取决于浏览器。
- `history-limit 20000`：设置新建窗格的历史上限，不能找回已丢弃输出。
- `set-clipboard on`：启用 tmux 终端剪贴板交互，系统剪贴板写入仍依赖终端支持与浏览器权限。

This optional user-wide profile disables tmux mouse capture, raises history for new panes and enables terminal clipboard integration. It cannot bypass browser permissions.

## 历史输出

ttyd 使用 `scrollback=10000`。刷新或切换导致 iframe 重建时，浏览器缓冲可能丢失。tmux 历史与浏览器滚动条不同；默认 tmux 前缀下按 Ctrl+B 后按 `[` 进入复制模式，`q` 退出。长期日志应写入文件。

## 手机与故障排查

尝试长按菜单或软键盘剪贴板入口；系统/浏览器行为不一致。检查终端焦点、剪贴板权限、HTTPS 和快捷键拦截。没有跨设备剪贴板同步，也不保证所有移动浏览器支持同样的选择操作。

References: [official ttyd](https://github.com/tsl0922/ttyd), [client options](https://github.com/tsl0922/ttyd/wiki/Client-Options).

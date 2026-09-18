# TTYd Hub Android

轻量 Android 客户端，连接你已部署的 Web TTYd Hub。适用于 Android 8.0+，纯 Java/WebView，不依赖 Google Play 服务，也不绑定某个 CPU 架构。为 M153 豆包手机的使用场景准备；当前没有 M153 实机测试记录。

## 安装与使用

优先从 [本机 IP 下载最新 APK](http://42.192.115.30:8182/downloads/ttyd-hub/ttyd-hub-latest.apk)；[GitHub Releases](https://github.com/learner20230724/web-ttyd-hub/releases) 作为备用。下载 APK 后，在手机上打开安装。首次安装可按系统提示允许该下载来源安装应用。

1. 输入你的服务器地址（完整 `https://域名` 或 `http://IP:端口`）。地址会保存，下次启动自动连接。
2. 如果服务设置了 HTTP Basic 认证，弹窗输入与网页相同的用户名和密码。安装包没有内置服务器地址或密码，用户名与密码由 Android Keystore 的 AES-GCM 密钥加密后保存在本机；下次自动登录，密码失效时重新输入。返回键菜单可清除保存的登录。
3. 选择或创建终端，使用原网页的全部会话功能。

手机操作：

- 手机使用独立阅读视图，不建立会改变共享终端尺寸的 ttyd 连接；同时使用电脑时，电脑窗口不会被手机挤窄。
- Codex 对话按 Markdown 排版，代码块可横向滚动；普通终端保留 ANSI 颜色。上下滑动阅读，长按文字选择/复制。
- 底部输入框点击即弹出系统键盘，长按粘贴，支持中文与多行文字；「发送」提交，「＋ → 仅输入」只粘贴不回车。「＋」也提供 Esc、方向键、Tab 和中断。
- 已去掉 APK 原生顶部工具栏。Android 返回键打开重新加载、更换服务器、返回桌面的菜单。
- 键盘与系统栏使用窗口 Insets 调整布局，横竖屏切换保留当前 WebView。
- 会话排序/置顶保存在本应用的 WebView 中，独立于手机浏览器；后台可能被系统回收，重新打开可重连。任务是否保留取决于服务器上的 tmux。

这是联网客户端，不在手机本地运行 ttyd、tmux 或 Codex。HTTP 为兼容已有部署而开放，建议使用 HTTPS；HTTPS 证书错误不会被忽略。外站链接交给系统浏览器，应用没有原生 JavaScript 接口、存储权限、后台保活服务或遥测 SDK。WebView 的缓存与站点存储遵循系统机制。

## 构建

需要 JDK 17+（本次使用 JDK 21）、Android SDK Platform 36 和网络（首次下载 Gradle/构建依赖）。Gradle Wrapper 固定 8.14.3，AGP 固定 8.13.0；compileSdk 36，targetSdk 35，minSdk 26。

```bash
export ANDROID_HOME=/path/to/android-sdk
cd android
./gradlew assembleDebug lintRelease
```

签名 Release 通过环境变量提供以下参数，签名文件不要放入仓库：

```text
HUB_ANDROID_KEYSTORE=/private/path/release.jks
HUB_ANDROID_STORE_PASSWORD=...
HUB_ANDROID_KEY_ALIAS=...
HUB_ANDROID_KEY_PASSWORD=...
```

```bash
./gradlew assembleRelease lintRelease
# 输出 app/build/outputs/apk/release/app-release.apk
```

版本升级应提高 `versionCode`，并用同一私钥签名，才能覆盖安装并保留站点数据。仓库不提供发布私钥。`minSdk` 允许 Android 8，但实际网页特性仍需要足够新的系统 WebView。

## 验证范围

- Release 编译、Android Lint、APK 签名校验与包元数据检查。
- 独立 Java 地址校验/同源导航策略测试：

```bash
mkdir -p /tmp/ttyd-address-test
javac -d /tmp/ttyd-address-test app/src/main/java/cn/guihualab/ttydhub/ServerAddress.java tests/ServerAddressTest.java
java -cp /tmp/ttyd-address-test ServerAddressTest
```

- Chromium 手机模式测试了真实触摸滑动、彩色历史、选择复制、输入/粘贴接续、拖动排序与置顶。
- 当前未连接 Android 手机或模拟器，因此不把浏览器模拟测试当作 Android WebView 或 M153 真机测试。安装后请先检查软键盘、长按菜单、登录与后台返回。

## 状态与兼容性

会话左侧：回答中转圈，完成未读绿点，查看后灰点。已读记录保存在当前设备；查看时页面须位于前台。
Linux 服务通过对应 tmux 窗格的 Codex 进程打开的 rollout 文件读取明确的 turn 事件，不以输出停顿判断完成，不修改 Codex 配置，不写额外日志。需要服务账号有权读取该进程的 `/proc` 和 rollout；不支持的 CLI 版本或其他程序显示普通终端输出，不伪造回答状态。
移动端每约 1.2 秒更新，保留最近 300 条用户/助手消息，不展示分析、工具与系统消息；它不是完整交互式 TUI，菜单选择可用「＋」内终端按键。Codex rollout 属于版本相关的兼容适配，升级后应验证。

## 本项目的在线更新

本项目是连接用户服务器的远程终端客户端，继续使用现有 Java/WebView 外壳；页面与业务逻辑从同一服务器加载，保留 origin、排序和已读记录。运行 `npm run deploy:web` 同时更新网页和 APK 在线界面，重新加载或完全关闭后打开应用生效，不强制打断正在编辑的页面。脚本要求本机 systemd 的 `KillMode=process`，保存会话清单并验证 tmux 窗格 PID 保留。

远程终端离线不能操作服务器，本项目不把私密终端记录打包进离线网页更新包。断网后保留当前画面与未发送输入，恢复网络自动重试读取；不要在发送结果不确定时直接重复发送。外壳改变（本次移除原生顶部栏）才需要覆盖安装 APK；之后页面更新无需重复安装。版本包回滚由服务器代码和构建版本管理，不承诺离线终端可用。

### 手机阅读设置

顶部右侧三个小按钮：「回答 / 全文」切换精简对话与完整彩色终端输出（含执行过程），「A− / A+」调整阅读字号（4–24 px）。默认延续精简回答模式，选择保存在本设备，重开仍生效。切换保留未发送草稿；全文模式仍不改变电脑终端尺寸。此功能在线更新，重新加载 APP 即可，无需重新安装 APK。

### 自动登录（Android 1.2）

覆盖安装后首次输入账号密码，后续重新打开自动登录。凭据按服务器协议、域名、端口和认证域隔离，仅保存于本机，不上传、不进入网页存储；外部资源不能接收登录凭据。返回键菜单的「清除已保存的登录」删除保存的账号密码。原生更新仍沿用包名和签名，保留阅读设置。

发送消息立即显示发送中；接口确认后显示「已送达终端 · 等待 Codex 接收」，即使 Codex 忙碌排队也可查看发送内容。正式对话中出现对应消息后自动合并。网络异常显示结果未确认，避免误以为失败而重复发送。该提示确认终端接收，不代表模型已处理；提示可手动关闭。

### 1.3：终端与阅读

顶部「✥」展开 ↑ ↓ ← → ↵ 五个终端按键，点击按键后保持展开，再点「✥」收起。回车不发送输入框草稿。「＋」保留 Esc、Tab、中断、仅输入。普通 shell 的发送提示为「已发送到终端」，仅明确检测到 Codex 的会话提示等待 Codex 接收，不再把所有终端当作 Codex。Markdown 与完整终端输出中的常见线框表格会渲染为可横向滑动的表格。

网页字号下限为 4 px。Android WebView 默认最小字体为 8，1.3 外壳解除该限制，让网页控制字号；旧 APK 若仍无法缩到 8 以下，可覆盖安装 1.3，之后页面更新仍在线生效。会话恢复和状态排序在服务端/网页生效，无需安装 APK。

### 会话菜单与归档

侧栏名称使用 12px 并完整换行。点「⋯」展开置顶、修改名称、移入归档。归档位于侧栏底部，会话和任务保持运行 30 分钟，可恢复；归档中的「彻底删除」立即终止任务，到期由服务端自动清理。归档期限持久化，Hub 重启不会重新计时。旧客户端调用删除接口也只归档，避免旧界面误操作直接终止。

### 固定 APK 下载

用户约定：以后 APK 优先使用本机 IP＋路径，不依赖 GitHub。固定最新包：
http://42.192.115.30:8182/downloads/ttyd-hub/ttyd-hub-latest.apk

版本文件位于同一路径 `ttyd-hub-android-X.Y.Z.apk`，附 `.sha256` 校验文件。运行 `python3 scripts/publish-apk.py android/app/build/outputs/apk/release/app-release.apk X.Y.Z`，签名验证通过后更新版本文件和固定最新包。只有该下载目录公开，Hub 会话和 API 继续要求原认证。

# TTYd Hub Android

轻量 Android 客户端，连接你已部署的 Web TTYd Hub。适用于 Android 8.0+，纯 Java/WebView，不依赖 Google Play 服务，也不绑定某个 CPU 架构。为 M153 豆包手机的使用场景准备；当前没有 M153 实机测试记录。

## 安装与使用

从 [GitHub Releases](https://github.com/learner20230724/web-ttyd-hub/releases) 下载 `ttyd-hub-android-1.0.0.apk`，在手机上打开安装。首次安装可按系统提示允许该下载来源安装应用。

1. 输入你的服务器地址（完整 `https://域名` 或 `http://IP:端口`）。地址会保存，下次启动自动连接。
2. 如果服务设置了 HTTP Basic 认证，弹窗输入与网页相同的用户名和密码。安装包没有内置服务器地址或密码，密码不写入应用设置。
3. 选择或创建终端，使用原网页的全部会话功能。

手机操作：

- 终端内快速上下滑动进入历史，历史内继续滑动查看；长按文字使用系统选择/复制菜单。双指缩放和长按选择不被快速滑动手势拦截。
- 顶部「键盘」调出输入法；历史中的输入会在完成选词后带入终端。
- 顶部「粘贴」读取当前剪贴板文字，沿用终端粘贴处理，不额外发送回车。剪贴板只在点击该按钮时读取。
- Android 返回键优先退出历史，再返回后台。菜单提供重新加载、更换服务器和使用说明。
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

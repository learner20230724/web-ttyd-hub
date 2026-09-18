# 项目交付约定

- APK 默认下载方式是本机 IP 直链，不再优先让用户通过 GitHub 下载。
- 固定最新包：http://42.192.115.30:8182/downloads/ttyd-hub/ttyd-hub-latest.apk
- 版本归档：同目录 `ttyd-hub-android-X.Y.Z.apk`，各包附 `.sha256` 校验文件；GitHub Release 继续作为备用。
- 构建与签名按 `android/README.md` 执行，同包名同签名递增 versionCode。仅网页修改在线发布，无需为了网页改动重打 APK。
- 发布签名包：`python3 scripts/publish-apk.py android/app/build/outputs/apk/release/app-release.apk X.Y.Z`。先验证签名，再公开 APK 和校验值；不发布 keystore、凭据或会话数据。
- 下载路由由 `/etc/caddy/Caddyfile` 的专用 `/downloads/ttyd-hub/*` 静态路径提供；其他路径必须保留原有认证。先读取实际配置再增量修改。

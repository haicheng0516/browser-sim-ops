# 第三方依赖说明

本仓库不包含、不复制任何第三方源码或二进制，只在运行时调用用户机器上已安装的工具：

| 工具 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| serve-sim（npm） | 模拟器画面镜像、原生 HID 输入、无障碍快照（`/ax`）、前台 App（`/foreground`） | Apache-2.0 | https://github.com/EvanBacon/serve-sim |
| Xcode / `xcrun simctl` | 列出设备、截图 | Apple 许可 | 随 Xcode 安装 |
| Node.js ≥ 22 | 运行脚本（内置 WebSocket / fetch） | MIT | https://nodejs.org |

`scripts/simops.mjs` 通过 serve-sim 0.1.48 的本地 WebSocket 消息格式发送触控/按键/按钮事件（与 serve-sim 自带 CLI 的 `tap`、`button`、`type` 命令相同的消息），按键码使用 USB HID Usage Tables 公开规范。serve-sim 内部协议未来可能变化；本适配不是稳定协议保证；`doctor`/`start` 健康检查可能无法发现输入协议变化，必须另做无真实业务的预检，不兼容时停止并回退，见 README。

基准对比中还测过 idb（fb-idb / idb-companion，MIT）和 AXe（随 XcodeBuildMCP 分发），本项目不依赖它们。

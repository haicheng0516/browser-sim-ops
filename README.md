# browser-sim-ops

Claude Code 与 Codex 共用的浏览器、iOS 模拟器操作 Skill：优先按元素定位，复用连接，合并已确认步骤，用明确状态判断成功，减少截图和模型往返。

**这是本地操作技能，不是浏览器插件，也不包含浏览器自动化服务。** 浏览器部分指导代理调用环境中已有的工具；模拟器部分提供 `simops` 命令行。两部分可以独立使用，不依赖任何业务系统。

## 快速安装

```sh
git clone https://github.com/haicheng0516/browser-sim-ops.git
cd browser-sim-ops
./install.sh          # Claude Code + Codex
# ./install.sh claude
# ./install.sh codex
```

安装只创建链接，不下载依赖、不启动模拟器、不更改 MCP 或浏览器配置；保留仓库目录。遇到同名目录/其他链接会报冲突，先核实已有安装，不会覆盖。

| 平台 | 默认安装位置 | 调用方式 |
|---|---|---|
| Claude Code 本地 CLI / Desktop Code 会话 | `~/.claude/skills/browser-sim-ops` | `/browser-sim-ops` |
| Codex 本地 CLI / App | `~/.agents/skills/browser-sim-ops` | 提示中写 `$browser-sim-ops` |

Codex 新安装采用[官方用户技能目录](https://learn.chatgpt.com/docs/build-skills)。若本仓库已链接到旧的 `$CODEX_HOME/skills`（默认 `~/.codex/skills`），安装器沿用原链接，避免重复发现。自定义位置用 `CODEX_SKILLS_DIR`；Claude 自定义配置根目录用 `CLAUDE_CONFIG_DIR`。只安装到当前用户，无需 sudo。

新开会话，确认技能列表中可发现该名称，并让代理读出本技能的职责和脚本路径。文件存在不等于客户端已经加载。[Claude Code 的本地个人技能](https://code.claude.com/docs/en/skills)不等于 Claude 网页聊天、Cowork 或云端会话支持本机模拟器；本项目不声称支持这些环境。

## 使用前提

| 使用范围 | 必需条件 |
|---|---|
| 只用浏览器方法 | 代理已获授权的浏览器工具，支持页面观察和元素操作；工具名称依客户端、插件而异 |
| iOS 模拟器脚本 | Apple Silicon macOS、完整 Xcode、已启动的 iOS Simulator、Node.js ≥22、serve-sim |
| 真机 / Android / 通用虚拟机 | 当前脚本不支持 |

本仓库没有自动安装浏览器工具。当前会话没有浏览器能力时，先配置客户端支持的浏览器连接；不能虚构工具名或用其他入口绕过客户端限制。

模拟器适配参考 serve-sim **0.1.48**。需要时可单独安装并固定版本：

```sh
npm install --global serve-sim@0.1.48
node scripts/simops.mjs doctor
```

安装依赖前先检查本机已有版本；不要反复下载。`SIMOPS_SERVE_SIM` 可指定已安装可执行文件或 `.js` 入口。脚本依次查该变量、PATH、已有 npx 缓存，不自动下载。其他 serve-sim 版本未保证兼容；`doctor` 检查依赖和健康状态，**不证明输入协议、实际点击或业务结果正确**。

## 怎么让 Claude / Codex 使用

可直接发送：

```text
使用 browser-sim-ops 操作当前任务授权的浏览器页面或 iOS 模拟器。
先确认可用工具和目标页面/UDID，复用现有现场；按元素定位。
只合并已经确认且不会改变后续定位的步骤，导航和提交后观察实际结果。
第一次失败立即停止依赖步骤；提交结果未知只核验，不重发。
只释放自己拥有的资源，最后报告实际观察和未验证范围。
```

Skill 是代理读取的操作规则，不是自动运行的函数。浏览器、Shell、模拟器的权限仍由客户端和用户控制。

### 浏览器

1. 在授权标签页读可交互元素，获取新鲜 DOM / 无障碍引用。
2. 同页互不影响的字段可顺序放入一次工具调用；导航或提交后立即观察。
3. 页面改变后重新取引用。视觉、画布、无法定位的控件才使用截图和坐标。
4. 提交结果未知时只读回原结果，不自动重试提交。

可用 [本地测试页](tests/fixtures/form.html) 做无真实业务的预检。在仓库下运行 `python3 -m http.server 8765 --bind 127.0.0.1 --directory tests/fixtures`，打开 `http://127.0.0.1:8765/form.html`；完成后 Ctrl-C 关闭服务。`?slow` 可模拟提交结果延迟。不要在占用中的端口重复启动。

### iOS 模拟器

先查看 `xcrun simctl list devices booted`，选定自己有权使用的设备。以下命令中的 UDID 和脚本路径要换成实际值：

```sh
node scripts/simops.mjs doctor --udid <UDID>
node scripts/simops.mjs start --udid <UDID> --owner <唯一任务名>
node scripts/simops.mjs ax --udid <UDID>
node scripts/simops.mjs run --udid <UDID> --owner <唯一任务名> --plan <计划.json>
node scripts/simops.mjs stop --udid <UDID> --owner <唯一任务名>
```

计划必须来自刚观察过的界面。例如，只核对已启动的系统设置 App：

```json
{"bundle":"com.apple.Preferences","steps":[
  {"assert":{"foreground":"com.apple.Preferences"}}
]}
```

实际导航与输入示例、条件语法、退出码见 [SKILL.md](SKILL.md)。需要临时计划时使用 `mktemp` 并立即设置 `trap` 清理；持久证据放仓库外。结束、失败和中断路径都要调用 `stop`，检查其返回值，不能把删临时文件当作释放设备。发生 `unknown` 不要重跑计划。

`start/run/stop` 对同一 UDID 使用原子命令锁，同 owner 也不能并发；`stop` 在执行仍持锁时拒绝释放。强制杀进程可能留下锁，需检查 `locks/<UDID>/holder.json`，确认旧进程确已退出、未知提交结果已核清，再移除该锁；不要按时间自动抢占。

这些锁仅协调使用本脚本、同一状态目录的进程，不阻止其他工具或用户点击设备。使用其他工具前也要确认设备没有被占用。复用已有 helper 不代表已获得其所有者的操作授权。

## 设为默认操作技能（可选）

在 Codex 的用户级或项目级 `AGENTS.md`、Claude Code 的 `CLAUDE.md` 中加入：

```text
需要操作浏览器或 iOS 模拟器时，默认加载 browser-sim-ops。
Codex 使用 $browser-sim-ops，Claude Code 使用 /browser-sim-ops。
遵守当前任务授权和客户端工具规则；工具不可用时说明缺口。
纯文本或源码任务不启动浏览器、模拟器。
```

新会话确认实际加载。技能只提供操作方法，不授予访问权限，也不会自动安装工具或执行任务。

## 验证范围与性能

`npm test` 可运行不依赖模拟器的回归测试，覆盖执行互斥、失败停止、未知提交、条件校验和资源生命周期。

[作者原始基准摘要](docs/benchmark.md)记录了少量本地表单与系统设置路线。该记录缺少随仓库提供的原始测量材料，且基线条件不完全一致；本次发布审查未重跑其性能数据，不能据此承诺固定提速比例。新增修正通过离线回归，未替代用户自己的应用测试。

未完成的兼容验证：自定义 App/WebView、Codex 预览服务器实际共存、不同 Xcode/serve-sim 版本、非美式文字输入及跨会话端到端耗时。先在无真实业务的页面或测试模拟器预检，再用于自己的任务。

## 故障、隐私与卸载

- `busy` / 退出码 4：已有 owner 或命令锁，核实占用，不能抢占。
- `unknown` / 退出码 3：可能已提交，只核验原结果。
- helper 不健康、启动结果未知、PID 身份变化：保留记录并停止；修复首次故障，不反复重启。
- Xcode 输入异常：不要自动执行可能重启 SpringBoard 的修复；先确认环境、权限和可恢复性。其他输入工具只能按当前平台规则使用。
- 输出摘要可能含页面文字、个人资料等信息；不要直接公开终端输出、计划、截图或本机状态。统计日志不保存输入文字，但含 UDID、owner 和时间，仍属本机资料。
- 依赖内部协议发生变化时停止使用模拟器适配，回到环境允许的原操作入口；浏览器方法可独立使用。

`./uninstall.sh` 仅移除指向本仓库的技能链接。状态默认在 `~/.local/state/browser-sim-ops`，也可指定 `SIMOPS_STATE_DIR` 或 `XDG_STATE_HOME`。卸载不会替你停止运行中的进程；先 `stop` 并核实，再处理状态目录。撤销集成时删除项目中的短引用即可。

[MIT 许可](LICENSE) · [第三方依赖](THIRD_PARTY.md)

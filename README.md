# 4-FIRE Assistant

专注交易的终端助手。模型理解目标、阅读专业方法并自主组织工作；程序提供工具、任务记录和交易约束。

内置研究、技术分析、回测、机会分析及独立复核。数据与可选交易服务均可通过 CLI 或 MCP 接入。策略维护通过显式授权的扩展提供。

需要 Linux、Node.js 22.19+ 和 Python 3.11+。本轮实现与待验收项见 [实施进展](docs/refactor-progress.md)，完整决策见 [重构设计](docs/refactor-design.md)。

## 安装与启动

```bash
npm ci --ignore-scripts
npm run build
npm install --global . --ignore-scripts
ffa --configure
ffa
```

先配置模型，再在目标目录启动。确认创建 .ffa 后，向主助手提供目标市场和服务资料。主助手阅读 BOOTSTRAP.md，自主完成必要的安装、发现与接入。

初始化必须验证目标市场的真实行情和历史 K 线，再由用户确认。交易服务可选；没有数据服务不能完成初始化。没有单独的初始化助手或 /finish 命令。

安装、发现、接入和交易许可分别确认。服务变更立即生效，不要求重做整个工作区初始化。

```bash
ffa --setup-compute
ffa --compute-status
```

所有工作区共用固定依赖的普通 Python 环境，实验记录各自保存。Python 可访问宿主文件和网络，不是沙箱。详见 [计算说明](resources/references/compute.md)。

## 使用

直接说明目标。简单问题由主助手处理；需要分离上下文或独立判断时再委派专家。方法通过技能提供，没有内置投资阈值或固定研究阶段。

| 命令 | 操作 |
| --- | --- |
| /status、/experts、/intents | 查看状态、专家和交易记录 |
| /continue | 确认继续未完成任务 |
| /cancel | 停止工作，保留已有结果和副作用 |
| /new [名称]、/resume [ID] | 空闲时创建或切换主会话 |
| /confirm ID VERSION、/decline ID VERSION | 回应当前精确确认 |
| /resolve ID VERSION 核对依据 | 空闲 TTY 中人工结案未知交易，不重发 |
| /revoke | 撤销未消费许可 |
| /configure | 配置模型与运行设置，重启生效 |
| /quit | 退出，保留工作 |

Enter 发送，Shift+Enter 换行，Ctrl+P 打开菜单，Esc 或 Ctrl+C 取消工作。忙碌时保留草稿，不加入新业务请求。

重开应用显示未完成工作和待核对交易，不自动恢复业务。--prompt TEXT 完成一次请求后退出；--continue 明确恢复上次请求。非 TTY 不能授予交易许可。

## 执行与存储

每份方案只覆盖一次精确原生调用。真实交易必须独立复核，再由用户确认。程序保存发送前记录，最多发送一次，不自动重试或附加其他操作。重启不恢复许可。

业务受理不等于成交。未知结果阻止本工作区新的交易写入，但不阻止查询和研究。用户核对后人工结案；结案不授权重发。

本机模型配置在 ~/.config/4-fire-assistant，支持 XDG_CONFIG_HOME。共享环境在 ~/.local/share/4-fire-assistant/runtimes/compute-0.2.0，支持 XDG_DATA_HOME。

.ffa 保存工作区配置、会话、执行账本、记忆、服务手册、技能和实验。不会覆盖项目根目录的 AGENTS.md。同一真实工作区只允许一个实例。

工作区采用 version=2，不迁移旧格式，也不删除旧数据。请使用新工作目录。备份前关闭应用；恢复备份不能撤销外部操作。

普通文件、Python 和 codemode 面向可信本地使用。受控交易路径不是能够阻止任意宿主代码绕过的安全沙箱。

## 开发验证

```bash
npm run check
npm test
git diff --check
```

测试使用真实本地逻辑、临时目录、真实 CLI 和 Python 进程。不使用假模型或模拟服务，不执行真实交易。Node 测试不下载 Python 依赖。

[配置说明](docs/configuration.md) · [技术设计](docs/technical-design.md) · [领域术语](CONTEXT.md) · [计算库与许可](python/README.md)

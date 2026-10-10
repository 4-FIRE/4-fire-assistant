# 4-FIRE Assistant

专注交易的终端助手，支持研究、技术分析、A 股单标的回测、机会分析、独立复核和精确确认后的执行。数据与交易服务通过 MCP 或 CLI 接入。策略维护通过可选扩展提供。

支持 Linux，需要 Node.js 22.19+。计算需要 Python 3.11+ 和 venv。

## 安装与启动

```bash
npm ci --ignore-scripts
npm run build
npm install --global . --ignore-scripts
ffa --configure
ffa
```

先配置模型，再在目标目录运行 `ffa`。确认创建工作区后，通过对话提供工具文档与连接材料。助手按需阅读文档、发现接口并提出接入约定。安装、发现和权限分别确认。`/finish` 确认完成初始化，`/quit` 保存进度退出。没有工具也可以完成初始化。

```bash
ffa --setup-compute
ffa --compute-status
```

所有工作区共用固定依赖的 Python 环境，各自保存实验。普通 Python 具有当前用户的宿主访问能力，不提供沙箱隔离。计算协议和模型限制见 [计算说明](resources/references/compute.md)。

## 对话与会话

用自然语言提出目标。协调者按任务复杂度决定直接处理或委派研究、复核。研究结论保存为工作区记忆，实验输入与结果按项目保存。

| 按键 | 操作 |
| --- | --- |
| Enter / Shift+Enter | 发送 / 换行 |
| 上下键 | 查找输入历史 |
| Ctrl+P | 打开操作菜单，支持筛选 |
| `/` / Tab | 查看命令 / 补全命令 |
| PgUp / PgDn | 滚动对话 |
| Esc / Ctrl+C | 菜单中返回；对话中取消工作 |
| Ctrl+D | 退出 |

| 命令 | 操作 |
| --- | --- |
| `/status`、`/experts`、`/intents` | 查看运行状态、专家及执行记录 |
| `/confirm ID VERSION`、`/decline ID VERSION` | 回应当前精确确认窗口 |
| `/resolve ID VERSION 核对依据` | 空闲 TTY 中人工结案未知意图，不重发操作 |
| `/revoke` | 撤销未消费许可 |
| `/new [名称]`、`/resume [ID]` | 空闲时创建或切换主会话 |
| `/configure` | 空闲时修改模型与运行配置，重启生效 |
| `/continue` | 明确继续未完成工作 |
| `/cancel` | 停止工作，保留记录和已有副作用 |
| `/quit` | 关闭应用，保留未完成工作 |

交互终端忙碌时保留输入草稿并拒绝新请求。非 TTY 批量输入按行处理。非 TTY 和 `TERM=dumb` 使用纯文本界面。状态栏显示当前活动和本次耗时。

`--prompt TEXT` 完成一次请求后关闭；`--continue` 继续上次请求后关闭。两者不能同时使用。非 TTY 不能授予交易许可。重开应用不会自动调用模型。

## 执行与存储

每个精确写入方案只覆盖一次原生调用。交易先独立复核一次，再请求用户确认；维护按约定可免复核。确认后检查参数、权限与来源绑定，再发送一次。重启不恢复许可。

结构化回执满足受理或拒绝规则时记录为 `Observed`，受理不代表成交。结果不明时记录为 `Unknown`，阻止本工作区继续写入。查询、研究和其他工作区仍可使用。用户核对外部事实后，用 `/resolve` 人工结案。

本机配置位于 `$XDG_CONFIG_HOME/4-fire-assistant`，默认 `~/.config/4-fire-assistant`。共享计算环境位于 `$XDG_DATA_HOME/4-fire-assistant/runtimes/compute-0.1.0`，默认使用 `~/.local/share`。

当前目录的 `.ffa` 保存配置、会话、执行账本、工具约定、资源覆盖和扩展授权。`.ffa/memory` 保存知识与系统回执；`.ffa/mcp` 保存确认安装的 MCP 软件。`projects/<项目>/runs` 保存实验。

同一真实工作区只允许一个实例。不同工作区独立协调执行，即使连接同一账户。配置修改后重启生效。备份前关闭应用，再复制工作区和所需本机配置。恢复备份不能撤销外部操作。程序不自动迁移或删除已有用户数据。

## 开发与验证

```bash
npm run check
npm test
git diff --check
```

测试使用明确输入和临时目录，检查执行状态、存储、配置、记忆与权限。不使用假模型或模拟服务，不执行真实交易。默认测试不下载 Python 依赖。设置 `FFA_TEST_RUNTIME` 为已安装的共享环境目录，可启用真实计算测试。

Python 算法测试与许可说明见 [计算包](python/README.md)。当前架构见 [技术设计](docs/technical-design.md)，接入格式见 [配置说明](docs/configuration.md)，业务术语见 [领域术语](CONTEXT.md)。

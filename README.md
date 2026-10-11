# 4-FIRE Assistant

专注投资工作的终端助手。模型接续已有研究、识别决策障碍并维护可修正的结论，减少用户重复说明和安排步骤的成本。程序提供工具、任务记录和交易约束。

内置研究、技术分析、回测、机会分析及独立复核。数据与可选交易服务均可通过 CLI 或 MCP 接入。策略维护通过显式授权的扩展提供。

需要 Linux、Node.js 22.19+ 和 Python 3.11+。

## 安装与启动

```bash
npm ci --ignore-scripts
npm run build
npm install --global . --ignore-scripts
ffa --configure
ffa
```

先配置模型，再在目标目录启动。确认初始化工作区后，程序在根目录建立资料结构与导航，在 .ffa 保存配置和应用状态。主助手整合已有 AGENTS.md 与资料，再根据目标市场和服务说明完成必要的安装、发现与接入。

初始化必须验证目标市场的真实行情和历史 K 线，再由用户确认。交易服务可选；没有数据服务不能完成初始化。没有单独的初始化助手或 /finish 命令。

安装、发现、接入和交易许可分别确认。服务变更立即生效，不要求重做整个工作区初始化。

```bash
ffa --setup-compute
ffa --compute-status
```

所有工作区共用固定依赖的普通 Python 环境，实验记录各自保存。Python 可访问宿主文件和网络，不是沙箱。详见 [计算说明](resources/references/compute.md)。

## 使用

直接说明目标。简单问题由主助手处理；涉及过去工作时先查所属资料。需要分离上下文或独立判断时再委派专家。方法通过技能提供，没有内置投资阈值或固定研究阶段。

| 命令 | 操作 |
| --- | --- |
| /status、/experts、/intents | 查看状态、专家和交易记录 |
| /cancel | 停止工作，保留已有结果和副作用 |
| /new [名称]、/resume [ID] | 空闲时创建或切换主会话 |
| /confirm ID VERSION、/decline ID VERSION | 回应当前精确确认 |
| /resolve ID VERSION 核对依据 | 空闲 TTY 中人工结案未知交易，不重发 |
| /revoke | 撤销未消费许可 |
| /configure | 配置模型与运行设置，重启生效 |
| /quit | 退出，保留工作 |

Enter 发送，Shift+Enter 换行，Ctrl+P 打开菜单，Esc 或 Ctrl+C 取消工作。忙碌时保留草稿，不加入新业务请求。

命令形式对齐 Pi 和 Claude Code。默认启动新会话；会话选择与请求内容分开。

```bash
ffa                         # 新会话，进入交互界面
ffa "分析苹果公司"           # 新会话，提交初始请求，保持交互
ffa -p "分析苹果公司"        # 新会话，处理后退出
ffa -r                      # 打开历史会话选择器
ffa --session <id>          # 打开指定会话，ID 为 UUID
ffa --session <id> "请求"    # 在指定会话中提交请求，保持交互
ffa --session <id> -p "请求" # 在指定会话中处理请求后退出
```

-p/--print 控制处理后退出；-r/--resume 打开会话选择器；--session 打开指定会话。--resume 和 --session 不能混用。-c/--continue 已移除，请选择明确的会话。--prompt 已移除，请改用位置参数。请求以 `-` 开头时，在请求前加 `--`。

stdin 或 stdout 不是 TTY 时，使用单次文本输出模式。没有位置参数时，从非 TTY 的 stdin 读取请求。会话选择器需要 TTY。

启动时也显示其他会话的未完成任务。打开有未完成任务的会话时，先选择恢复、取消或暂不处理。恢复沿用原请求及已完成专家结果。暂不处理时保留原任务，不提交初始请求。用 /resume 再次打开当前会话可重新选择。单次输出模式不自动恢复；请先在交互模式恢复或取消。待核对交易继续阻止新的交易写入。

其他会话有未完成的 SDK 运行时，程序拒绝启动当前会话的新请求或取消操作，防止 SDK 一起恢复旧运行。请先用 --resume 或 --session 打开旧会话处理。

用 /new [标题] 手动命名新会话；省略标题时使用“新会话”。非 TTY 不能授予交易许可。

--list-sessions 列出当前工作区的会话，然后退出。输出格式为 JSON。每项包含 id（UUID）、title、createdAt 和 updatedAt。时间使用 UTC（ISO 8601）。此命令不调用模型，也不切换会话。旧会话索引会自动升级。旧索引中的未知时间显示为 null。

提交、恢复或结束请求时更新 updatedAt。结束请求包括回答完成、未回答和取消。查看和切换会话不更新时间。

## 执行与存储

每份方案只覆盖一次精确原生调用。真实交易必须独立复核，再由用户确认。程序保存发送前记录，最多发送一次，不自动重试或附加其他操作。重启不恢复许可。

业务受理不等于成交。未知结果阻止本工作区新的交易写入，但不阻止查询和研究。用户核对后人工结案；结案不授权重发。

本机模型配置在 ~/.config/4-fire-assistant，支持 XDG_CONFIG_HOME。共享环境在 ~/.local/share/4-fire-assistant/runtimes/compute-0.2.0，支持 XDG_DATA_HOME。

areas 保存长期目标、约束、决策与复盘，projects 保存研究与证据，knowledge 保存通用知识，sources 保存服务手册。角色与技能定制放在 roles 和 .agents/skills，临时计算放在 scratch。目录导航使用 AGENTS.md，具体项目说明可用 README.md。资料与其他助手共享，正文只维护一份；FFA 用 memory_recall 查找资料，read/write/edit 处理正文。

初始化为 Claude Code 创建引用 AGENTS.md 的 CLAUDE.md，并将 .claude/skills 链接到 .agents/skills。已有入口保留，由助手整合。其他 agent 可用自己的文件与计算工具继续研究；会话、工具连接和交易授权各自管理。兼容范围见[配置说明](docs/configuration.md#跨-agent-使用)。

.ffa 保存连接配置、会话、任务和执行账本。同一真实工作区只允许一个 FFA 实例。工作区外置资料允许主动维护；助手修改 .ffa 配置须确认，程序正常保存任务与回执无需逐次确认。用户触发工作后才推进，不根据文档待办自动启动业务。

工作区配置采用 version=3，会话索引采用 version=2。运行 --upgrade-workspace 可单独升级已有工作区状态，不需要模型配置。当前支持会话索引 version=1 到 version=2 的迁移。启动 FFA 或运行 --list-sessions 时，也会执行此索引升级。升级保留会话内部编号、标题和当前会话，只增加 UUID 和时间字段。旧索引没有时间记录，createdAt 和 updatedAt 初始为 null。不修改任务、交易账本、服务配置或共享资料。升级前关闭实例并备份完整工作区；恢复备份不能撤销外部操作。其他旧配置格式仍不支持迁移。

已有工作区的 AGENTS.md 只需局部补充 FFA 帮助入口，不必覆盖全文。此操作不迁移会话或交易记录。步骤见[资料更新与状态格式说明](docs/configuration.md#已有工作区的资料更新)。

普通文件、Python 和 codemode 面向可信本地使用。受控交易路径不是能够阻止任意宿主代码绕过的安全沙箱。

## 开发验证

```bash
npm run check
npm test
git diff --check
```

测试使用真实本地逻辑、临时目录、真实 CLI 和 Python 进程。不使用假模型或模拟服务，不执行真实交易。Node 测试不下载 Python 依赖。

本地测试不证明真实模型和服务的完整业务行为。运行验收需使用获准服务，检查对话式初始化、按需选择技能、专家中断恢复和 codemode 部分完成记录。交易复核与确认界面应在不发送真实订单的条件下检查。

[配置说明](docs/configuration.md) · [技术设计](docs/technical-design.md) · [领域术语](CONTEXT.md) · [计算库与许可](python/README.md)

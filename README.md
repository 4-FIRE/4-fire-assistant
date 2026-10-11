# 4-FIRE Assistant

按工作区启用的 Pi 投资扩展。模型理解目标、阅读专业方法、自主组织工作；程序提供工具和必要约束。

提供研究、技术分析、回测、交易机会分析、专家协作和受控交易。不维护独立 CLI、模型登录或任务调度器。

## 安装

需要 Pi 1.1.0、Linux、Node.js 22.19+。普通计算需要 Python 3.11+。

先在本仓库安装依赖：

```bash
npm ci --ignore-scripts
```

再从目标投资工作区根目录安装本地包：

```bash
pi install --local /绝对路径/4-fire-assistant
pi
```

按 Pi 提示确认项目信任。模型、认证和会话继续使用 Pi 原生配置。本地包直接加载 TypeScript，不需要先构建。

本包保留 private=true，不提供 npm 发布版本。只支持从投资工作区根目录启动，不向父目录搜索 FFA 状态。

## 初始化与使用

| 状态 | 行为 |
| --- | --- |
| 未初始化 | 仅提示 `/ffa init`，不加载投资角色、技能或业务工具，不创建业务文件 |
| 初始化未完成 | 仅提示，执行 `/ffa init` 才接续 |
| 已完成 | 启动时自动加载投资能力，等待用户请求 |

执行 `/ffa init`，确认当前目录后通过对话准备资料和来源。需验证真实行情及历史 K 线，由完成工具核实记录，再由用户确认。交易服务可选。

完成后执行 Pi 原生 `/reload`，刷新角色、技能和业务工具。以后从根目录启动会自动启用。重载或退出会暂停未完成初始化，不自动继续。

直接向模型说明目标。简单问题不强制建项目或委派。模型按需读取技能，用真实查询和 Python 支持判断。专业方法可修改文档和技能，不必修改流程代码。

| 命令 | 用途 |
| --- | --- |
| `/ffa init` | 开始或接续初始化；已完成时刷新资源 |
| `/ffa status` | 查看启用状态与待核对交易 |
| `/ffa revoke` | 撤销未消费的复核许可 |
| `/ffa resolve ID 核对依据` | 用户确认人工结案，不重发 |
| `/ffa python /绝对路径/bin/python` | 确认共享 Python 解释器 |

确认窗口默认选择取消。没有确认通道时，初始化、接入变更和交易操作均不能授权。

## 资料与工具

`areas/` 保存长期事务，`projects/` 保存研究，`knowledge/` 保存知识，`sources/` 保存服务手册，`scratch/` 保存临时计算。`.ffa/` 保存初始化状态、来源、回执与独立交易账本，不保存另一套主会话或模型认证。

主要工具：

- `ffa_status`、`ffa_sources`、`ffa_source_read`、`ffa_record`：业务状态、原生查询与真实回执。
- `ffa_configure_source`、`ffa_finish_initialization`：接入与完成确认。
- `ffa_python`、`ffa_delegate`：可追溯计算与按需专家。
- `ffa_prepare_trade`、`ffa_execute_trade`：精确方案与受控执行。

来源配置见[连接说明](resources/references/connections.md)，Python 环境与限制见[计算说明](resources/references/compute.md)。

## 交易与恢复边界

真实交易需要精确方案、独立复核与用户确认。发送前记录可靠提交后才调用服务。超时、异常或不完整回执保持未知，阻止本工作区的新交易写入，仍允许查询和研究。

聊天分支、重载和重启不能回退账本或恢复许可。人工结案不授予重发许可。服务受理不等于成交，也不保证同一账户跨工作区防重。

专家使用 Pi 持久会话，研究员可按当前分支的 expertId 追问；复核使用新的独立上下文。接受 Pi 原生恢复，不保证精确恢复中断的工具调用。已保存产物可以继续使用，未确认副作用不自动重放。

Python、Bash 和扩展具有宿主权限，不是沙箱。不要通过其他 MCP 配置重复暴露已接入的交易服务。

不兼容旧 CLI、配置、会话、数据库或扩展格式。使用新工作目录；不迁移或删除旧资料。旧工作区有结果不明交易时，先核对外部事实。

## 验证状态

类型检查与新测试覆盖真实 Pi package 加载、无干扰状态、CLI 参数和查询、Python 计算、交易状态与存储约束。没有使用假模型、模拟服务、个人凭据或真实交易。

**真实模型协作、实际行情服务初始化、MCP 服务与交互确认仍需获准环境验收。** 本地测试通过不等于可以直接投入实盘。

```bash
npm run check
npm test
git diff --check
```

[技术设计](docs/technical-design.md) · [迁移与验收记录](docs/migration-plan.md) · [ADR](docs/adr/0001-use-pi-extension.md) · [领域术语](CONTEXT.md) · [计算库许可](python/README.md)

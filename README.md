# 4-FIRE Assistant

按工作区启用的 Pi 协作扩展，用于学习、项目推进、研究与决策支持，也提供投资分析和受控交易能力。

模型负责分析与协调；ffa 提供资料入口、专家协作、Python 依赖安装和受控调用。不另建主 Agent，不自动开展任务或交易。

## 安装

需要 Linux、Node.js 22.19+，以及已配置模型和认证的 Pi。Python 计算需要 Python 3.11+。当前开发与测试使用 Pi 1.1.0，其他宿主版本需另行验证。

从目标工作区根目录安装并启动：

```bash
pi install --local git:github.com/4-FIRE/4-fire-assistant
pi
```

`--local` 将包声明保存在当前工作区，避免全局加载。按 Pi 提示确认项目信任；每次从工作区根目录启动，ffa 不向父目录查找状态。本包不提供 npm 发布版本。

本地开发：先在源码仓库执行 `npm ci --ignore-scripts`，再从工作区执行 `pi install --local /绝对路径/4-fire-assistant`。本地安装直接加载来源目录，请保留源码和依赖。

## 初始化

1. 执行 `/ffa init` 并确认目录。程序创建缺失的资料目录和根 `AGENTS.md`，不覆盖已有文件。
2. 向助手说明目标与工作约定。外部服务和目标市场均为可选；需要接入时提供 CLI/MCP 名称、用途、官方文档或配置位置，不提供凭据值。
3. 助手整理资料，展示已注册能力和权限，由你确认完成初始化。
4. 执行 Pi 原生 `/reload`，加载完整能力。

未初始化时，ffa 只提示入口，不接管普通 Pi 工作。初始化中断后保留资料，须再次执行 `/ffa init` 才接续；完成后启动自动启用，但等待用户请求。

## 日常使用

直接向助手说明任务，例如整理项目资料、比较研究结论、委派独立复核或运行计算。无需手动编排固定流程。

| 命令 | 用途 |
| --- | --- |
| `/ffa init` | 开始或接续初始化；已完成时重载资源 |
| `/ffa status` | 查看启用状态和调用时结果不明的记录 |
| `/ffa agents` | 查看专家执行；TUI 中可阅读报告、会话及停止任务 |
| `/ffa python setup` | 手工重试共享 venv 的准备并激活，无需指定路径 |
| `/reload` | Pi 原生命令，重载插件与资源 |

- **能力接入**：通过助手接入 CLI/MCP、维护目录与权限。方法见[接入技能](resources/skills/provider-connections/SKILL.md)，调用与记录核对见[调用技能](resources/skills/provider-calls/SKILL.md)。
- **专家协作**：内置通用专家、研究员和复核员；`agents/<name>.md` 可补充或定义职责。中断主会话不会停止后台专家；需要停止时明确提出，或使用 TUI 的 `/ffa agents`。重载会取消专家。详见[专家协作](docs/feat/agent-collaboration.md)。
- **Python 环境**：所有工作区共用当前用户的独立 venv。就绪工作区启动时自动创建或安装锁定依赖，成功后在当前 Pi 进程激活；主会话与专家通过 Bash 使用 `python` 或 `python3`。环境异常时提醒，修复后用 `/ffa python setup` 重试。系统 Python、外部终端、已有脚本和历史结果不变。共享依赖更新会影响其他工作区；更换插件版本或手工重试前应停止相关脚本。详见 [Python 说明](python/README.md)与[计算参考](resources/references/compute.md)。
- **资料维护**：可要求“整理当前项目资料”或“检查交付并结项”，助手按[项目整理与维护技能](resources/skills/project-maintenance/SKILL.md)归集有用成果、保留必要证据并清理范围内不再需要的临时产物，不清理 `.ffa/` 内部记录。

聊天恢复使用 Pi 原生 `pi --continue` 或 `pi --resume`；不会恢复旧批准或自动重发业务调用。

正常退出时，按调用当时的权限保留 `ask/review` 原文件，将 `allow` 历史账本和结果自动归档到 `.ffa/archives/`，无需配置清单。账本按批次合并，结果使用 gzip 压缩；归档可靠保存后才移走散文件。重载或切换会话不归档，强制终止不保证执行。旧结果路径不存在时，先通过 `ffa_provider_record` 读取回执恢复该文件，不重复调用外部接口。

## 工作区资料

| 位置 | 用途 |
| --- | --- |
| `AGENTS.md` | 资料导航与工作约定 |
| `areas/`、`projects/` | 长期事务、任务过程、证据和结论 |
| `knowledge/` | 可复用知识 |
| `providers/` | 提供方手册、覆盖缺口与验证依据 |
| `scratch/` | 临时计算与可重建产物 |
| `agents/`、`.agents/skills/` | 职责补充、自定义专家与工作区技能 |
| `.ffa/` | 内部配置、权限、调用账本与结果文件 |

模型通过专用工具修改内部状态，不直接编辑 `.ffa/`。用户用外部编辑器修改配置后执行 `/reload`。复制工作区前停止旧实例；不支持多机同时写入同步目录。存储布局与复制边界见[文件存储](docs/feat/file-storage.md)。

## 更新与兼容性

当前发布版本为 **0.3.2**，继续使用 `ffa/0.3` 工作区格式。现有 0.3.0 工作区可直接使用，不需要升级脚本，也不改写格式标识。归档目录在首次实际归档时创建；历史散文件按同一规则归档。归档产生后，不支持退回不识别归档的旧版插件读取记录。

插件更新使用所用 Pi 版本的原生包管理命令；本地安装则更新来源源码，依赖变化后执行 `npm ci --ignore-scripts`，再重载或重启 Pi。

ffa 没有 `/ffa update`。本版不提供也不需要工作区转换；`scripts/upgrade-0.3.0.mjs` 仅为空基线，无需运行。更早的不兼容工作区须保留原数据，不在原目录重新初始化。详见[版本规则](docs/technical-design.md#31-加载范围与格式)和[脚本说明](scripts/README.md)。

## 权限与风险

- `allow` 直接调用，`ask` 请求批准，`review` 要求助手先组织独立复核且调用仍需批准，`deny` 禁止调用。交易接入建议 `review`；**程序不核验复核是否完成，`allow` 不要求本次批准。**
- 注册、连接成功和获得执行许可是不同事实。协议成功或受理不证明业务完成、成交或模型结论正确。
- 每份调用记录最多发送一次。取消、超时、重载和聊天恢复不撤销外部副作用；结果不明时先核对记录，不自动重发。
- ffa 权限只约束自己的调用入口。Pi 原生 MCP、Bash、Python 和其他扩展不受这套批准与账本机制完整控制，不是沙箱。

完整规则见[能力与权限设计](docs/capability-design.md)。真实模型、外部提供方和完整 TUI/RPC 交互仍需获准环境验收，本地测试通过不代表可以投入实盘。

## 开发与文档

```bash
npm run check
npm test
git diff --check
```

`npm test` 包含冒烟和 E2E 测试，并生成测试用 `dist/`；运行时直接加载源码。包内容可用 `npm pack --dry-run` 检查。测试分组与限制见[验证边界](docs/technical-design.md#6-验证边界)。

- [架构原则](docs/architecture-guidelines.md)：职责、依赖和开发约束。
- [技术设计](docs/technical-design.md)：模块、生命周期、版本与资源加载。
- [能力与权限](docs/capability-design.md) · [专家协作](docs/feat/agent-collaboration.md) · [文件存储](docs/feat/file-storage.md)：当前专题设计。
- [领域术语](CONTEXT.md) · [Python 环境、原生库与许可](python/README.md)。

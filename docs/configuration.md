# 配置与接入

本文说明本机配置、工作区布局和服务接入。使用入口见 [README](../README.md)，运行边界见 [技术设计](technical-design.md)。

## 本机模型配置

ffa --configure 设置模型、思考级别、超时与认证路径。ffa --login PROVIDER 使用独立终端输入凭据。凭据不进入模型对话、手册或记忆。

配置默认位于 ~/.config/4-fire-assistant/config.local.json，支持 XDG_CONFIG_HOME。服务连接保存在工作区配置中。

```json
{
  "version": 1,
  "model": {"provider": "your-provider", "modelId": "your-model"},
  "thinkingLevel": "medium"
}
```

可选字段为 authPath、modelsPath、runtime 与 research。认证和模型覆盖路径必须为绝对路径。runtime 支持 modelTimeoutMs、generationRetries、progressIntervalMs；research.python 指定创建共享环境的 Python 绝对路径。

本机配置修改后重启生效。--configure-file 导入本机配置，不接入服务或授予交易许可。

未完成任务仍绑定原模型。启动或切换到该会话须使用原模型。若要更换模型，先用原模型完成或取消未完成任务。

枚举值必须使用 JSON 字符串。例如 thinkingLevel 使用 `"high"`，不能使用 `["high"]`。连接 transport、apiKeyHeader、操作 access 和能力数组中的每个元素也遵守此规则。

## 工作区

首次启动须确认初始化投资工作区。程序创建缺失的目录和入口文档；已有内容保留，由主助手整合工作约定与导航。拒绝确认或非交互启动不会创建新工作区。

```text
工作区/
  AGENTS.md
  CLAUDE.md                  # 引用 AGENTS.md
  areas/AGENTS.md
  projects/AGENTS.md
  projects/<name>/README.md  # 按需创建的具体项目说明
  knowledge/AGENTS.md
  sources/AGENTS.md
  sources/<id>/GUIDE.md
  roles/<role>.md
  .agents/skills/AGENTS.md
  .agents/skills/<name>/SKILL.md
  .claude/skills -> ../.agents/skills
  extensions/<id>/
  scratch/runs/<runId>/
  .ffa/
    config.json
    state.sqlite
    instance.lock
    packages/
```

根目录是模型的文件工作目录。areas 保存长期目标、约束和决策，projects 保存有完成条件的研究，knowledge 保存跨任务知识。具体正文、服务手册、角色补充和技能按需创建。项目和长期事务的计算记录放在所属目录的 runs 子目录。

.ffa/config.json 使用 version=3。initialization 起初为 null；只有完成工具验证资料入口及真实调用记录，并取得用户确认后才登记完成。

```json
{
  "version": 3,
  "initialization": null,
  "sources": {},
  "extensions": {}
}
```

旧格式不兼容，原文件不迁移、不删除。请使用新工作目录，不能仅修改旧配置的版本号。没有 --workspace-file 导入入口。

当前工作区 .ffa 外的资料，包括角色和技能，可以直接维护。助手修改 .ffa 配置通过有确认及校验的专用操作完成，数据库与回执不能由普通文件工具改写。程序正常保存会话和运行记录无需逐次确认。工作区外文件修改另需确认。

## 跨 agent 使用

从投资工作区根目录启动 agent。共享约定和目录导航使用 AGENTS.md，具体项目说明保留 README.md。处理子目录内容前读取其上级及本目录的 AGENTS.md，不假定每个工具都会自动递归加载。引用使用相对路径，便于移动整个工作区。

FFA 从 .agents/skills/<name>/SKILL.md 加载本地技能。Codex 支持此发现路径，见[官方技能说明](https://learn.chatgpt.com/docs/build-skills)。技能使用标准 name、description front matter，脚本与参考资料放在技能目录内。说明所需能力与实际依赖，避免把 FFA 的工具名称当作通用接口。

Claude Code 使用 .claude/skills 发现项目技能，见[官方技能说明](https://code.claude.com/docs/en/skills)。初始化创建相对目录链接，指向唯一的 .agents/skills 正文。CLAUDE.md 只用 @AGENTS.md 导入公共约定，兼顾不能直接加载 AGENTS.md 的版本或配置，见[官方指令文件说明](https://code.claude.com/docs/en/memory)。本项目支持 Linux；复制或版本管理工作区时需保留符号链接。

程序不覆盖已有 CLAUDE.md 或 .claude/skills。初始化时由助手补充缺失的公共引用。已有独立技能目录可为共享技能添加相对链接；同名冲突先核对，不覆盖定制。程序也不批量改名或删除已有用户 README.md、skills 目录。新结构不改变 version=3。

共享的是资料、工作约定和本地技能。FFA 包内技能仍由安装包提供，不复制到工作区。roles、extensions、SOUL.md 和 BOOTSTRAP.md 是 FFA 的加载约定；根 AGENTS.md 说明其他 agent 如何按需阅读。扩展清单不会自动变成其他工具的子 agent 配置。

其他 agent 用自己的文件和计算工具工作；使用服务前核实连接和依赖。服务手册保存原生 CLI/MCP 用法，凭据、连接配置和会话状态由各工具分别管理。其他 agent 不改写 .ffa 的任务或执行账本。缺少 FFA 受控执行能力时仅准备交易方案，不把共享资料理解为交易授权。

## 初始化与服务

初始化由主助手处理，不使用另一套对话循环。先检查并整合资料结构和已有规则，再按用户资料选择阅读、澄清、发现和安装。完成前需实际查询目标市场行情与历史 K 线；交易服务可选。

configure_source 接收 id、connection、operations。id 须以小写字母开头，只含小写字母、数字和连字符，长度为 1–64。用户确认后立即连接并保存；失败保留原配置。来源参数错误不表示工作区版本错误，修正调用即可，无需重建目录。remove_source 只移除一个来源，保留历史资料。故障或接口变化局部修复，不重启整套初始化。

sources/AGENTS.md 是接入知识索引；每个来源用 GUIDE.md 记录接口含义、单位、时间、复权、分页、错误和真实验证结果。手册不是机器权限，也不证明服务当前可用。

| connection.transport | 连接字段 |
| --- | --- |
| http | url，可选 apiKeyEnv、apiKeyHeader、timeoutMs |
| stdio | command，可选 args、env、timeoutMs |
| cli | 绝对 command，可选 env、timeoutMs、maxOutputBytes |

env 将子进程变量名映射到本机环境变量名，不存变量值。HTTP 认证支持 X-API-Key 或 Authorization: Bearer。URL 不接受用户名、密码、查询参数或片段。

下面仅展示配置结构，不是预置服务：

```json
{
  "connection": {"transport": "http", "url": "https://example.invalid/mcp"},
  "operations": [{
    "name": "native_query",
    "description": "Read provider data",
    "access": "read",
    "roles": ["coordinator", "researcher", "reviewer"]
  }]
}
```

MCP 使用服务原生 schema。CLI 还需声明对象 schema 和 argv；参数作为独立 argv 或标准输入 JSON 传递，不拼 shell。具体字段见 [原生接入说明](../resources/references/tool-connections.md)。

交易操作必须标记 access=write。所有交易写入都需要独立复核和用户确认，不能配置关闭。outcomes.accepted 与 outcomes.rejected 用 JSON Schema 解释业务回执；缺少条件、条件冲突或结果不完整时保持未知。不通过真实下单测试配置。

## 软件安装

本地软件缺失时先阅读可信说明，再通过 install_package 提出安装器绝对路径和参数。支持 npm install、pip install、uv tool/pip install、python -m pip install，不支持 shell 或 sudo。

安装在 .ffa/packages 运行，使用独立 HOME 和缓存。超时 120 秒，输出上限 1 MiB；该目录不是沙箱。已有或远端服务不要重复安装。失败可能产生文件，不自动重装。

安装、发现接口、接入权限和交易执行分别确认。普通文件阅读不要求逐文件确认，但不得读取或传播凭据。

## 技能、角色与扩展

包内通用行为和基础角色与工作区角色补充共同生效。roles/coordinator.md、researcher.md、reviewer.md 补充当前工作区职责，不整体替换基础角色。明确用户定制优先于一般默认工作方式，不改变程序能力授权。

每次用户请求和确认恢复前，重新读取角色补充、根 AGENTS.md、可选 SOUL.md 与技能索引，无需重启。该次请求的主助手和专家共享这些指引；来源索引在提示渲染时读取，以反映刚完成的接入。技能和其他资料正文由模型按需读取当前文件。

包内 resources/skills 提供默认方法，.agents/skills 中的同名工作区技能可以覆盖。角色或技能的实质维护须区分方法依据、长期偏好和临时假设，并在交付时说明。新指引用于后续请求；当前任务需要改用新方法时，说明调整原因。

未初始化时加载包内首次引导，可选根 BOOTSTRAP.md 提供补充。不创建默认 SOUL.md 或 BOOT.md，也不自动执行待办任务。

策略维护默认关闭。用户在停止应用后可显式修改 .ffa/config.json 的 extensions 授权：

```json
{
  "strategy-maintainer": {"maintainer": ["read", "prepare"]}
}
```

来源 operations.roles 还需授权 strategy-maintainer/maintainer。扩展只能准备方案，不能独立执行交易。

自定义扩展使用 extension.json 声明 version=1、id 和 roles。每个角色声明 id、Markdown prompt 与 capabilities。能力只允许 read、prepare、compute，工作区授权不能超过申请。程序不加载扩展主进程代码。扩展角色文字在请求开始时重读；角色集合或授予能力的变更需要核对配置并重启。

## 记忆与 Python

memory_recall 检索根入口及 areas、projects、knowledge、sources、roles、.agents/skills、extensions、scratch、docs 的当前 Markdown 正文。query 按字面匹配路径或正文，空 query 浏览；scope 限定资料相对路径。返回路径、片段和行号，用 read 阅读，write/edit 更新所属正文。没有独立 memory 目录或记忆写入工具。

每页最多 30 个匹配文件，使用 nextOffset 翻页；文档变化后从头检索。隐藏目录仅检索 .agents/skills，其他隐藏目录及 node_modules、__pycache__、runs 均不扫描；.claude/skills 别名不重复检索。跳过符号链接和大于 1 MiB 的文件，通过 skipped 报告；需要这些内容时按明确路径阅读。检索范围超过 20000 个入口时要求缩小 scope。未命中不证明没有旧资料。

只保留能改善后续工作的关键事实、纠正和方法。有现成正文时直接更新或引用，不记录逐次操作流水账，也不把建议和临时假设升级为用户约束。

ffa --setup-compute 安装共享固定依赖，ffa --compute-status 查看状态。环境为 $XDG_DATA_HOME/4-fire-assistant/runtimes/compute-0.2.0；未设置时使用 ~/.local/share。

python 接收可选 owner，以及 code、inputs 与 evidenceRefs，执行普通 Python。每次保存 main.py、inputs.json、evidence.json、manifest.json、stdout.txt、stderr.txt 及脚本自行生成的产物。

owner 为 projects/名称 或 areas/名称，可使用多级目录；省略则保存在 scratch/runs。research_list 返回所有运行及相对路径，可用 owner 限定项目、长期事务或 scratch；read 读取源码、日志和结果。中断后保留原实验记录，重算创建新运行。没有固定 indicators/backtest 调用协议。

运行限制为 120 秒和 16 MiB 日志，取消会停止当前进程组。Python 可访问宿主文件与网络，不提供强隔离。详见 [计算说明](../resources/references/compute.md)。

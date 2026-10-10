# 配置与接入

本文说明本轮实现。完整目标见 [重构设计](refactor-design.md)，验证边界见 [实施进展](refactor-progress.md)。

## 本机模型配置

ffa --configure 设置模型、思考级别、超时与认证路径。ffa --login PROVIDER 使用独立终端输入凭据。凭据不进入模型对话、手册或记忆。

配置默认位于 ~/.config/4-fire-assistant/config.local.json，支持 XDG_CONFIG_HOME。服务连接不再放入本机配置。

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

启动时确认创建 .ffa。拒绝创建或非交互启动不会创建工作区。不覆盖当前项目的 AGENTS.md。

```text
.ffa/
  config.json
  state.sqlite
  AGENTS.md
  BOOTSTRAP.md
  sources/AGENTS.md
  sources/<id>/GUIDE.md
  roles/<role>.md
  skills/<name>/SKILL.md
  extensions/<id>/
  memory/
  packages/
  projects/<project>/runs/<runId>/
```

config.json 使用 version=2。initialization 起初为 null；只有完成工具验证真实调用记录并取得用户确认后才登记完成。不要手动填入伪造的验证引用。

```json
{
  "version": 2,
  "initialization": null,
  "sources": {},
  "extensions": {}
}
```

旧格式不兼容，原文件不迁移、不删除。请使用新工作目录。没有 --workspace-file 导入入口。

## 初始化与服务

初始化由主助手处理，不使用另一套对话循环。用户提供资料后，模型选择阅读、澄清、发现和安装。完成前需实际查询目标市场行情与历史 K 线；交易服务可选。

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

包内 resources/skills 提供专业方法。Pi 技能加载器读取工作区 skills，同名工作区技能覆盖包内技能。每轮提示包含技能索引，模型按任务读取完整方法。

工作区 AGENTS.md 和来源索引每轮加载。BOOTSTRAP.md 只在未初始化时加载。可选 SOUL.md 提供行为说明；没有默认 BOOT.md 自动业务任务。

roles/coordinator.md、researcher.md、reviewer.md 可覆盖角色说明，重启后生效。角色、技能或行为指引的工具写入需要用户确认。普通服务手册和研究产物可直接维护。

策略维护默认关闭。用户在停止应用后可显式修改 extensions 授权：

```json
{
  "strategy-maintainer": {"maintainer": ["read", "prepare"]}
}
```

来源 operations.roles 还需授权 strategy-maintainer/maintainer。扩展只能准备方案，不能独立执行交易。

自定义扩展使用 extension.json 声明 version=1、id 和 roles。每个角色声明 id、Markdown prompt 与 capabilities。能力只允许 read、prepare、compute，工作区授权不能超过申请。程序不加载扩展主进程代码。

## 记忆与 Python

memory_recall、memory_read、memory_save 处理长期结论、偏好和纠正。修改记忆使用当前 revision；系统回执不能由模型覆盖。接入知识直接维护手册，详细实验留在项目，不复制多份状态。

ffa --setup-compute 安装共享固定依赖，ffa --compute-status 查看状态。环境为 $XDG_DATA_HOME/4-fire-assistant/runtimes/compute-0.2.0；未设置时使用 ~/.local/share。

python 接收 project、code、inputs 与 evidenceRefs，执行普通 Python。每次保存 main.py、inputs.json、evidence.json、manifest.json、stdout.txt、stderr.txt 及脚本自行生成的产物。

research_list 列出项目或运行状态；read 读取源码、日志和结果。中断后保留原实验记录，重算创建新运行。没有固定 indicators/backtest 调用协议。

运行限制为 120 秒和 16 MiB 日志，取消会停止当前进程组。Python 可访问宿主文件与网络，不提供强隔离。详见 [计算说明](../resources/references/compute.md)。

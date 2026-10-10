# 配置与接入

当前目录为工作区。本机配置保存连接材料，工作区配置保存接入约定与权限。修改后重启生效，两者均不保存单次执行许可。

## 模型与认证

运行 `ffa --configure` 设置模型、思考级别、超时和认证路径。运行 `ffa --login PROVIDER` 在独立终端输入凭据，也可使用 SDK 支持的提供商环境变量。凭据不进入模型对话或记忆。

本机配置默认为 `$XDG_CONFIG_HOME/4-fire-assistant/config.local.json`，未设置时使用 `~/.config/4-fire-assistant/config.local.json`。

```json
{
  "version": 1,
  "model": {"provider": "your-provider", "modelId": "your-model"},
  "sources": {
    "sample": {"transport": "http", "url": "https://example.invalid/mcp", "apiKeyEnv": "SERVICE_TOKEN"}
  }
}
```

| 连接 | 字段 |
| --- | --- |
| HTTP MCP | `url`、可选 `apiKeyEnv`、`apiKeyHeader`、`timeoutMs` |
| stdio MCP | `command`、可选 `args`、`env`、`timeoutMs` |
| CLI | 绝对 `command`、可选 `env`、`bindingFiles`、`timeoutMs`、`maxOutputBytes` |

HTTP 支持 `X-API-Key` 或 `Authorization: Bearer`。配置只保存环境变量名。`env` 将子进程变量名映射到本机变量名。服务名称和路径由用户提供。

## 工作区初始化与记忆

首次启动时显示真实路径，确认后创建 `.ffa`。拒绝或非交互启动不创建工作区。通过对话提供工具文档与连接材料，模型按需查询和澄清。

| 初始化命令 | 操作 |
| --- | --- |
| `/help` | 查看命令 |
| `/retry` | 继续处理已保存材料，不授权重复外部动作 |
| `/finish` | 展示接入约定，确认后完成初始化；允许暂不接入工具 |
| `/quit` | 保存进度退出；存储故障须先修复 |

知识、接入进度、纠正与研究结论保存在 `.ffa/memory/*.md`。角色共用 `memory_recall`、`memory_read`、`memory_save`。修改已有记忆需要 id 和当前 revision；系统回执不能由模型覆盖。记忆不代替软件安装、实时事实、接口约定或执行许可。

读取用户文档和发现外部接口前，终端显示精确路径或入口并请求确认。默认复用已保存资料。用户明确要求重新核实时，再次确认并保留原记录。发现接口不自动授予操作权限。

完成初始化后，可直接对话请求安装、连接或权限变更。助手显式提出单来源修改，经终端确认后保存，重启生效。`/configure` 处理模型和运行设置。

## MCP 安装

本地服务缺少软件时，助手先阅读可信安装说明，再提出安装器绝对路径与完整参数。支持 `npm install`、`pip install`、`uv tool/pip install` 和 `python -m pip install`。不提供 shell、sudo 或任意脚本入口。

安装在 `.ffa/mcp` 运行，使用独立 HOME 和缓存，不继承凭据。超时为 120 秒，输出上限为 128 KiB。包和安装脚本须可信，该目录不构成宿主沙箱。

安装、发现接口与确认权限分别处理。远端服务无需本地安装，已有软件不重复安装。安装回执作为记忆保存，但不证明软件当前可用。失败或取消可能留下文件；先核对，再根据新的明确请求重新安装。

## 调用约定

本机 `sources` 保存连接，`.ffa/tools/<source-id>.json` 保存操作约定。只有 `.ffa/config.json` 的 `enabledSources` 中列出的来源会加载。同 id 的连接目标不能隐式覆盖；变更目标时使用新 id，再明确移除旧来源。

每项操作提供 `name`、`description`、`access`、`schema` 和 `roles`。MCP 的名称、说明和 schema 须匹配实际目录。CLI 约定依据用户资料与确认方案。角色可为内置角色或已启用的扩展角色。

下面的名称仅作示例，程序没有预置该操作：

```json
{
  "version": 1,
  "sourceId": "sample",
  "operations": [{
    "name": "change",
    "description": "User supplied operation description",
    "access": "write",
    "schema": {
      "type": "object",
      "properties": {"value": {"type": "string"}},
      "required": ["value"],
      "additionalProperties": false
    },
    "roles": ["coordinator"],
    "execution": {"reviewRequired": true, "confirmationRequired": true},
    "outcomes": {
      "accepted": {
        "type": "object",
        "properties": {"status": {"const": "accepted"}, "id": {"type": "string", "minLength": 1}},
        "required": ["status", "id"]
      },
      "rejected": {
        "type": "object",
        "properties": {"status": {"const": "rejected"}},
        "required": ["status"]
      }
    }
  }]
}
```

交易要求独立复核一次。维护可设 `reviewRequired=false`，所有外部写入仍须精确确认。模型不能在调用时修改要求。

`outcomes` 描述完整结果。仅匹配 accepted 表示受理，仅匹配 rejected 表示拒绝。两者都匹配或都不匹配时为未知。批量规则须覆盖全部项目，退出码或协议成功不代替结果判断。只读结果可为文本，也可提供 `resultSchema` 检查完整性。

CLI 须提供 `argv`。固定字符串原样传递；用 `{"parameters":"json"}` 或 `stdin="json"` 传递完整 JSON，也可用 `{"parameter":"字段名"}` 绑定标量。标量绑定要求 schema 的 `additionalProperties=false`，所有字段必需且恰好绑定一次。无参数操作仅接受空对象。不使用 shell 或参数文件绑定。`bindingFiles` 固定影响目标的文件，变化后来源停用。

操作以 `来源/原生名称` 暴露。来源之间可有同名操作，参数保留原生格式。结果未知时阻止本工作区写入；核对后用 `/resolve ID VERSION 核对依据` 人工结案，不重发原调用。

## 资源与扩展

`.ffa/resources` 中的同路径 Markdown 或 JSON 覆盖包内已登记资源。启动读取快照，修改后重启生效。资源文本不能授予权限。

策略维护默认关闭。在完整工作区配置中添加：

```json
{
  "extensions": {
    "strategy-maintainer": {"maintainer": ["read", "prepare"]}
  }
}
```

在操作的 `roles` 中另行授权 `strategy-maintainer/maintainer`。扩展只能准备写入，确认与执行由协调者处理。

自定义扩展放在 `.ffa/extensions/<id>`。`extension.json` 包含 `version=1`、`id` 和 `roles`。角色声明 `id`、Markdown `prompt` 与 `capabilities`，申请能力限 read、prepare、compute。工作区授权不能超过申请。`toolRequests` 只作申请资料。扩展仅包含 Markdown、JSON 和普通目录，不加载代码，不接受符号链接。

可在完成初始化后编辑文件并重启，或导入完整工作区配置：

```bash
ffa --workspace-file /absolute/path/workspace-config.json
```

导入取得同一实例锁，校验接入与扩展后保存，不发送业务操作。配置损坏时保留原文件并报错。

## 共享 Python

`ffa --setup-compute` 安装固定依赖。环境位于 `$XDG_DATA_HOME/4-fire-assistant/runtimes/compute-0.1.0`，默认使用 `~/.local/share`。本机 `research.python` 可指定创建环境的 Python 绝对路径，默认 `python3`。需要 Python 3.11+、venv 和安装时的网络访问。

`ffa --compute-status` 检查环境。运行器设置 120 秒超时与 16 MiB 输出上限，取消时终止进程组。普通 Python 不提供宿主隔离。

实验位于 `projects/<项目>/runs/<UUID>`。`research_list` 列出项目与实验；`research_read` 按 project、id 读取 manifest.json、request.json 或 result.json，支持 offset 翻页。研究结论通过记忆工具读取。协议与模型限制见 [计算说明](../resources/references/compute.md)。

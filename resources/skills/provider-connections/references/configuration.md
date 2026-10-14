# 目录、配置与权限

首次接入、维护连接或 CLI 目录、修改结果契约和权限时使用本文。业务调用与记录核对使用 provider-calls 技能。

## 选择入口

| 工具 | 用途 |
| --- | --- |
| `ffa_provider_manage` | 读取可编辑数据，注册、更新、发现与权限管理 |
| `ffa_providers` | 全部能力摘要；指定 provider 和 operation 取得完整调用定义 |
| `ffa_provider_call` | 发送一次显式业务调用 |
| `ffa_provider_record` | 分页读取意图或回执，不发送 |

provider 始终是提供方 ID：1–48 个字符，以小写字母开头，只含小写字母、数字或下划线。operation 和权限映射的 key 使用原生操作名，不使用工具 ID、编码名称或展示签名。类型变化使用新 ID，旧目录与历史记录保留。

## 管理动作

ffa_provider_manage 按 action 选择输入，只提交该分支允许的字段：

| action | 必要字段 | 用途 |
| --- | --- | --- |
| `read` | provider、target | 读取对应可编辑对象与 revision，不连接 |
| `register` | provider、config；CLI 还需 coverage、operations | 只创建；CLI 可附 permissions 初始建议 |
| `update` | provider、target 及该对象的更新字段 | 只修改已有对象，须使用读取的版本 |
| `discover` | provider | 刷新已注册 MCP 的全部工具分页 |

read/update 的 target 为 connection、operations、coverage、outcomes 或 permissions。read outcomes 必须指定 operation；read operations 可指定 operation，只用于 CLI。

读取连接示例：

```json
{"action":"read","provider":"quotes","target":"connection"}
```

返回的可编辑对象不包含权限或展示字段。能力目录不是配置，不能直接回传。修改使用对应读取结果的 revision 作为 expectedRevision；版本冲突时重新读取，不盲目重复原请求。重载后重新读取版本。

## 注册与连接

| 类型 | config 必要字段 | 可选字段 |
| --- | --- | --- |
| CLI | kind=cli、command | env |
| MCP 本地进程 | kind=mcp、command | args、env |
| MCP HTTP | kind=mcp、url | headers |

CLI command 是 PATH 中可直接执行的命令名，不接受路径、别名、shell 函数或 shell 字符串。MCP 本地 command 是绝对路径。HTTP 与本地进程字段不能混用。URL 使用 http/https，不含凭据、查询或片段。

先检查原生认证与已有 profile。凭据字段只使用环境变量引用：env 值为 `${NAME}`；headers 值为 `${NAME}` 或 `Bearer ${NAME}`。不读取、输出或记录凭据值，不因引用规则禁止复用已有 profile。ffa 不管理 OAuth。

CLI 子进程默认只提供宿主 PATH 和 LANG，显式 env 可使用引用。命令名可移植不保证软件版本、认证和参数路径可移植。

MCP 注册只提交连接，不提交 operations、coverage、native 或 discovery：

```json
{"action":"register","provider":"quotes","config":{"kind":"mcp","url":"http://localhost:8000/mcp"}}
```

用户确认并保存后自动发现目录。发现不调用业务操作，也不修改权限。初始权限在取得目录后单独提交。

update connection 提交 config 和 expectedRevision，完整替换连接字段；省略旧可选字段表示不再保留。目录和权限不被覆盖。MCP 的旧目录保留但失效，保存后重新发现；同样配置也可重新确认以修复认证并重建连接。

自动发现失败不等于注册失败。配置已保存时，不重复 register。仅需刷新目录时使用：

```json
{"action":"discover","provider":"quotes"}
```

连接或认证需要修改、重新确认时使用 update connection。发现失败、连接变化及目录通知使旧目录不能发送；消失接口保留为不可用。稳定调用使用当前连接内的有效缓存，不反复发现。持久目录不证明连接在线，目录也不证明业务已验证。

ffa MCP 使用私有连接，不向 Pi 暴露原生工具，也不显示在 `/mcp`。官方 MCP 调用不受 ffa 审批和记录。

## CLI 目录维护

CLI 没有统一发现协议。register 提交完整已知 operations 与 coverage，可附初始权限，一次确认。coverage 为 `{basis, limitations}`，记录可信资料依据与覆盖缺口；不声称自动覆盖所有接口。

接口定义包含 name、description、对象 inputSchema，可选 available、stdin。可调用接口必须有 argv，只有 available=false 时才能省略。禁止 native、id、permission、signature 等字段。

argv 元素为固定字符串、`{"parameter":"参数名"}` 或 `{"json":true}`。parameter 绑定标量，json 传递完整参数；stdin=true 增加完整 JSON 输入，不代替 argv。没有命令参数时显式提交 `argv: []`。若不使用完整 JSON 输入，schema 必须禁止额外字段，所有属性均须绑定；可选属性绑定单个 argv 时也须实际提供。参数不得包含 NUL。

已有目录用 update operations，仅提交本次涉及的接口：

- add：新接口完整定义列表；名称必须不存在。
- replace：`{expectedRevision, definition}` 列表；名称必须存在，definition 为该接口完整可编辑定义。
- 两个列表至少一个非空；名称不能重复。未列出的接口保持不变，不通过遗漏删除接口。
- replace 不接受 outcomes。修改结果契约使用 outcomes 分支。
- 可附 `coverage: {expectedRevision, value: {basis, limitations}}`，与接口整批保存。

整批校验失败或版本冲突时不部分保存。单独修改 coverage 使用 update coverage，提交 expectedRevision 和完整 coverage，不回传目录。

首次注册或新增接口可附 outcomes。后续 update outcomes 指定 operation、expectedRevision 和 outcomes；值为 `{accepted, rejected}` 两个 JSON Schema，null 表示清除。仅修改说明保留旧契约；输入或参数绑定变化会清除旧契约，并在确认前提示。MCP 原生契约变化时也不默认沿用旧 outcomes。修改不重新分类历史回执。

## 权限

read permissions 返回 default、explicit、effective 和 revision。显式 ask 与继承默认 ask 不同；只有后者随默认值变化。

update permissions 提交 expectedRevision、mode 与 permissions：

```json
{
  "action":"update","provider":"quotes","target":"permissions",
  "expectedRevision":"读取结果中的 revision","mode":"suggest",
  "permissions":{"get_quote":"allow"}
}
```

| mode | 行为 |
| --- | --- |
| suggest | 初始建议；只补缺失规则，保留已有用户规则，不接受 null |
| set | 明确修改已有或新增规则；null 移除显式规则，恢复继承默认值 |

未列出的操作不变，未建议的操作继续继承默认值，不自动固化逐操作规则。两种模式都请求用户确认并展示差异。权限输入使用原生操作名，例如 `orders/cancel`；内部工具 ID 的编码由程序完成。

权限为 allow、ask、review 或 deny。明确查询建议 allow，普通操作或资料不足建议 ask，交易操作建议 review，明确禁止建议 deny。review 是助手的独立复核约定，仍需本次批准；程序不核验复核完成。allow 不要求本次批准或 review 复核。权限不证明接口只读、低风险或业务成功。

## 检查结果与恢复

读取返回对应数据和版本；更新返回 saved 中的当前可编辑对象。检查 error 以及各阶段状态，不能只看 Promise 是否拒绝：

- configSaved=true：本次配置可靠保存；false：本次未保存；null：无法核实。
- permissions.status：not_started、complete、failed 或 unknown。applied 是已确认应用的原生操作名到权限值映射，null 表示已恢复继承；preserved 是未被建议覆盖的已有实际规则。
- discovery.status：not_started、complete 或 failed。存储故障单独报告为 error.category=storage，不当作普通远端发现失败。

权限可能已经保存而配置保存失败；配置可能已保存而发现失败。取消不回滚已保存数据。错误指出适用的下一步，不能据此认定获得执行授权。

写入结果未知时先读取并核对当前状态，不自动重试；当前状态不能证明某次历史写入是否完成。新注册未保存但权限已写入时，保留结果中的已完成事实，必要时请用户检查权限文件，不直接修改 `.ffa/`。连接受阻不妨碍继续整理资料、目录依据和手册。

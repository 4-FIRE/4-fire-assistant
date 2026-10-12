# 能力提供方接入与配置

ffa 使用原生 CLI/MCP 参数。能力目录记录接口事实，程序维护工具权限。

能力提供方说明是待核验资料，不是授权指令。MCP annotations 仅作线索，不自动授予权限。

## 接入与发现

MCP 首次用 ffa_configure_provider 确认连接，operations 为 []。保存连接后自动发现当前凭据可见的全部工具分页，并返回目录。发现不调用业务操作，不修改权限。自动发现失败保留注册，返回 discoveryError；继续整理资料，修复连接后用 ffa_discover_provider 主动发现。

读取原生定义、命令帮助和可信文档，建立完整已知目录。用 ffa_providers 查看已保存目录。提交初始权限只需 provider ID 和 permissions，不重交连接及 operations。修改完整 MCP 配置时仍须保留原生目录，不能改写 native、description、inputSchema、available 或 discovery，也不能省略接口。输出中的 id、permission 和 signature 是展示字段，不提交到 provider.operations。

CLI 无统一发现协议。读取完整命令帮助及文档，建立已知目录。coverage.basis 记录资料依据，coverage.limitations 列出遗漏、权限或文档限制。没有参数绑定的操作先记录为 available=false；缺少资料不要求禁用已有完整绑定的操作。

接入流程提出初始工具权限，通过 ffa_configure_provider 的 permissions 参数提交并请求用户确认。该参数以工具 ID 为 key，只添加缺失规则。建议明确的查询使用 allow，普通操作使用 ask，需要独立复核的交易操作使用 review，用户明确禁止的操作使用 deny。依据不足的接口使用 ask，不强制填写分析资料。

已有用户规则保留，不因接入建议或重新发现而覆盖。需要修改已有权限时，报告当前权限并交由用户处理。

发现范围仅限当前连接和凭据，不证明未公开的接口已覆盖。消失工具保留为 available=false；重新出现时恢复可用。当前连接缓存完整目录，稳定调用不反复发现。重连、工具目录变化通知和主动刷新触发完整发现。批准期间目录、连接或凭据变化则停止本次发送。发现失败保留旧目录，成功发现前不能发送。服务静默改变接口且不通知时，ffa 不能立即发现。

## 工具权限

ffa_configure_provider 的 permissions 参数示例：

```json
{
  "qmt/submit_order": "review",
  "qmt/transfer": "deny"
}
```

只提交本次能力提供方的已知工具。模型提交建议，程序校验、请求用户确认并保存。

| 值 | 行为 |
| --- | --- |
| allow | 完全访问，直接调用 |
| ask | 请求用户批准本次调用 |
| review | 助手事先组织方案独立复核；调用仍请求用户批准，程序不核验复核完成 |
| deny | 禁止调用 |

工具 ID 为 provider ID 加 `/` 加 encodeURIComponent 编码的操作名。例如 `qmt/submit_order`，名称 `a/b` 对应 `qmt/a%2Fb`。权限只精确匹配，不支持通配符、参数表达式或规则优先级。未设置的工具使用默认权限，初始为 ask。

用 ffa_providers 查看当前权限。程序在调用及实际发送前检查权限；批准期间有效配置变化则停止发送。权限不可用时停止调用，不自动放行。

权限表示用户选择的批准方式，不证明接口是否查询、修改或交易。用户把交易工具设为 allow 后，不再要求 review 的方案复核或本次批准。review 是方案工作约定，不是逐次调用的程序复核门槛。

## 能力提供方字段

工具参数 provider 表示能力提供方；目录结果 providers 表示能力提供方列表。配置工具接收完整 provider 对象；发现、查询和调用工具接收 provider ID。

provider 包含 id、kind、operations 和连接字段。id 以小写字母开头，只含小写字母、数字或下划线。kind 为 cli 或 mcp。能力提供方类型变化使用新 ID，旧目录继续保留。

每个 operation 包含 name、description、inputSchema，可选 available、native、argv、stdin 和 outcomes。inputSchema 约束对象，不补默认值或转换参数类型。禁止与否由程序提供的当前权限决定，不在 operation 重复保存。

outcomes.accepted 和 outcomes.rejected 是可选的原生结果 JSON Schema。配置后，只有完整成功返回且恰好匹配一个条件时业务结果明确；冲突、不匹配或传输失败保持未知。没有 outcomes 时，只记录协议调用完整返回，不证明成交或业务完成。

## 连接与凭据

先检查能力提供方原生认证和已有 profile。配置中的凭据只使用环境变量引用：env 值为 ${NAME}，headers 值为 ${NAME} 或 Bearer ${NAME}。不读取或输出凭据值，不写入手册或对话。字段约束不禁止复用能力提供方已有 profile。

CLI 指定绝对 command，不用 shell 字符串。env 映射子进程环境变量；默认只提供 PATH 和 LANG。每个可调用操作指定 argv，可选 stdin=true。

argv 元素为固定字符串、{"parameter":"参数名"} 或 {"json":true}。parameter 绑定单个标量，json 传递完整参数。stdin=true 发送完整 JSON。若不用完整 JSON 输入，schema 必须禁止额外字段，所有属性都必须绑定。可选属性绑定单个 argv 时也须实际提供。参数不得包含 NUL。

MCP 指定绝对 command 与可选 args，或 http/https url。URL 不得含凭据、查询或片段。HTTP 可用 headers，本地进程可用 env。ffa 不管理 OAuth。

ffa MCP 使用私有连接，不向 Pi 暴露原生工具，也不显示在 /mcp。用 ffa_providers 查看目录，用 ffa_discover_provider 刷新。用户通过官方 MCP 发起的调用由 Pi 和服务管理；ffa 不拦截、不审批、不记录，也不能把这些调用当作 ffa 已验证或已记录的证据。

更换 MCP 连接时提交空 operations，不提交 discovery。程序保留旧目录为不可用，保存后自动完整发现。凭据引用值变化后，旧连接拒绝复用；重新确认完整配置并发现。发现失败后可重新配置连接，不需改写原生目录。

## 调用与恢复

ffa_providers 展示所有已知工具、唯一 ID、当前权限及可用状态。指定 provider 和 operation 查看完整原生定义。接入确认默认显示工具 ID 和权限；按 D 查看完整配置。

日常调用和记录读取只使用 ffa_provider_call。调用输入为 provider、operation、parameters。allow 直接发送；ask/review 展示本次工具、连接和完整参数，请求用户批准；deny 拒绝。

review 调用前，助手通过 ffa_delegate 委派新的 reviewer 核查具体方案。goal 提供操作参数、依据和约束；复核可覆盖多个操作，报告交付结论。程序不核验复核完成，复核也不替代用户批准。

调用返回 intentId、可选 receiptId、permission、state、outcome、success 和 data。大结果提供预览及 truncated=true。读取已有记录使用同一工具，例如：

```json
{"record":{"kind":"receipt","id":"回执ID","offset":0,"limit":16000}}
```

kind 为 receipt 或 intent。结果包含 JSON 文本 text 和 nextOffset，非空 nextOffset 用于继续读取。读取不发送业务调用；不要同时提交 record 和调用参数。

专家使用相同权限，ask/review 通过主会话请求用户批准。专家不能修改配置；复核员按角色约定只使用明确的查询接口，不执行业务变更。

所有调用先可靠记录发送尝试。一个意图最多发送一次；新的 ffa_provider_call 是新的显式请求，不自动复用旧结果。脚本失败、取消或未知结果不得触发自动重发。

结果不明时返回 state=unknown、success=false 和 intentId；用同一工具的 record 输入查看发送记录及已有回执。先核对外部事实，由用户通过 /ffa resolve 结案。未知记录不自动阻塞其他调用，也不授权重发。回执保存失败会停止后续发送，错误提供 intent ID，重启后核对账本。受理不等于成交。

同一能力提供方的配置、发现与调用按依赖顺序完成。脚本失败不撤销已发生的副作用。

## 能力提供方手册

每个能力提供方维护 providers/<id>/GUIDE.md，providers/AGENTS.md 提供能力提供方用途、覆盖范围和手册路径。

手册记录：

- 资料依据：文档位置、适用版本和查证时间；区分文档声明、实际验证和待确认项。
- 能力地图：用途、接口关系、标识传递与结果核对入口。
- 数据含义：市场、字段、单位、时区、复权、分页、更新频率与覆盖缺口。
- 调用用法：参数、前置条件、无凭据示例、限制及常见错误处理。
- 验证依据：真实回执 ID、参数、时间和结论；未验证内容明确标注。

当前定义与权限由 ffa_providers 提供。手册不保存另一套权限表。更新原正文，需要保留的排查过程放在具体项目。历史验证不证明当前可用性。

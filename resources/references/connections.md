# 原生来源配置

FFA 使用原生 CLI/MCP 参数，不定义统一行情模型。先读真实服务文档，再提出配置。配置由 ffa_configure_source 请求用户确认。

## 共同字段

source 包含 id、kind、operations。id 以小写字母开头，只含小写字母、数字或下划线。kind 为 cli 或 mcp。

每个 operation 包含 name、description、access 和 inputSchema。access 是 read 或 write。inputSchema 是约束对象参数的 JSON Schema，不进行默认值填充或类型转换。

写操作还需 outcomes，包含 accepted 和 rejected 两个 JSON Schema，用来判断原生业务回执。只有完整成功返回且恰好匹配一个条件时结果明确。传输错误、匹配冲突、缺少匹配或超时保持未知。受理不等于成交。

连接凭据只使用环境变量引用：env 值为 ${NAME}，headers 值为 ${NAME} 或 Bearer ${NAME}。不将凭据值写入配置、手册或对话。

## CLI

指定绝对 command，不使用 shell 字符串。env 可映射子进程环境变量；默认仅提供 PATH 和 LANG。每个 operation 指定 argv，可选 stdin=true。

argv 元素可以是固定字符串、{"parameter":"参数名"} 或 {"json":true}。前者绑定单个标量，后者传递完整 JSON 参数。stdin=true 通过标准输入发送完整 JSON。

若不用完整 JSON 输入，schema 必须禁止额外字段，所有已声明属性都必须绑定。可选属性用于单个 argv 时也须实际提供值。参数不得包含 NUL。查询超时或退出码非零不能成为成功验证证据。

## MCP

指定绝对 command 与可选 args，或指定 http/https url。HTTP URL 不得含凭据、查询或片段。HTTP 可用 headers，本地进程可用 env。

仅有 read 操作的 MCP 来源由 Pi 内置连接，使用 ffa_<id> 服务名。未确认的工具保持隐藏；用 /mcp 查看连接状态。不要在 Pi 配置中覆盖这些服务名。

包含 write 操作的 MCP 来源使用 FFA 私有连接，原生工具不向模型暴露。不要在其他 MCP 配置中再次公开同一交易服务。真实发送还会核实当前原生输入 schema，既有批准不能跨连接或 schema 变化使用。

## 资料与证据

每个服务只维护一份 sources/<id>/GUIDE.md。记录原生参数、市场含义、限制、真实查询例子和验证时间，不写凭据。

ffa_source_read 返回 receipt id。大结果用 ffa_record 分页读取。聊天里的声明不构成验证回执。接入变更撤销旧批准，重新验证当前数据后再工作。

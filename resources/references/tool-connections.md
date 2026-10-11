# 原生服务接入

CLI 与 MCP 都可提供数据或交易能力。程序保存连接、操作权限、原生参数绑定和交易回执约定，不统一行情数据格式。

## 接入工具

locate_cli 的 command 是单独命令名，只定位不执行。inspect_source 接收 connection 和可选 args；CLI 默认 args 为 ["--help"]，MCP 读取工具清单。每次外部发现均需确认。

install_package 接收安装器的绝对 command 与 args，支持 npm/pip/uv/python -m pip。按可信说明安装缺失软件，不用 shell 或 sudo。安装在工作区 .ffa/packages 下运行；失败可能已产生文件，先核对。

configure_source 接收 id、connection 和 operations，确认后立即可用。id 以小写字母开头，只含小写字母、数字和连字符，长度为 1–64；不能含下划线。ID 或参数错误时修正该次调用，不要重建工作区。连接失败保留原配置。remove_source 只移除指定来源及权限，需要确认；保留资料和历史记录。

source_catalog 显示当前角色获准的接口。source_read 使用 来源/操作 名称和原生 parameters，保存实际 evidenceRef。

## connection

HTTP MCP 使用 transport: "http" 与 url，可用 apiKeyEnv 引用本机环境变量；apiKeyHeader 可为 Authorization 或 X-API-Key。

stdio MCP 使用 transport: "stdio"、command 和 args。env 的键是子进程变量名，值是本机环境变量名，不是凭据内容。

CLI 使用 transport: "cli" 和绝对 command，可选 env、timeoutMs、maxOutputBytes。env 同样只保存环境引用。不要把凭据放进 URL、参数、手册或源码。

## operations

每项包含原生 name、description、access 与 roles。access 为 read 或 write；roles 是明确授权的角色名列表。不按操作名猜测副作用。所有交易变更都归 write。

MCP 的 schema 来自服务，不必重复声明参数。CLI 必须声明对象类型的 JSON schema 和 argv：

- 字符串元素是固定参数，不经 shell。
- {"parameter":"field"} 将明确标量字段作为一个独立参数；字段必须存在且不能被遗漏。
- {"parameters":"json"} 将完整 parameters 作为单个 JSON 参数。
- stdin: "json" 可改用标准输入传完整参数，不能同时使用 JSON 参数或字段绑定。

CLI 可选 resultSchema 验证原生输出；查询可以返回文本或 JSON。不要为行情编造统一字段。

## 交易回执

所有 write 都要求独立复核和用户确认，不能配置关闭。outcomes.accepted 与 outcomes.rejected 是针对原生业务结果的 JSON Schema。恰好一个匹配时才登记明确受理或拒绝。

未提供 outcomes 时，两个条件都不匹配，结果保持未知。条件冲突、协议失败、无法解析或不完整结果也不能当作确定完成。回执条件必须覆盖全部调用范围，不能只验证批次里某一个成功项。

协议成功不证明业务受理，业务受理不证明成交。手册说明订单状态、核对方式和部分结果含义，不通过真实下单测试接入。

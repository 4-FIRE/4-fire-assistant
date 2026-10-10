# 工具接入说明

这份文档供模型按需阅读，不是问卷、普通回答格式或必经阶段。对话、用途、缺口、研究结论与接入进度以自然语言保存为记忆。记忆不能安装 MCP、建立连接或授予权限；实际操作边界仍须检查原生参数并取得用户确认。

## 阅读与发现

read_material 读取用户提供的普通资料文件绝对路径，有大小和翻页限制；不要读取凭据。read_reference 读取已登记包内说明。locate_cli 查询一个命令名，不执行。inspect_source 只需要 name、kind 与必要连接；location 未知时可省略，明确 connection 优先于 location。CLI 用 discoveryArgs 提出文档依据下的帮助或契约查询，默认 --help。MCP 只连接并取得工具清单。不得用这些入口发送业务操作。每份发现回执独立保留为记忆，不覆盖先前子命令的材料。默认复用已读材料；用户明确要求重新核实已变更接口时，可用 refresh=true 提出新的发现，仍须确认，并保留旧版本。

## MCP 安装

本地 MCP 软件尚未安装时，先阅读可信安装文档，再用 install_mcp 指定名称、包安装器绝对路径和原生 args。支持 npm install、pip install、uv tool/pip install、python -m pip install；不接受 shell、sudo 或任意脚本命令。用户确认完整 argv 和安装目录后执行，120 秒超时、128 KiB 输出上限。工作目录为本工作区 .ffa/mcp，使用独立 HOME/缓存，不继承凭据；包安装器和安装脚本仍属于用户信任边界，不提供宿主隔离。

安装不自动授权操作。成功回执作为记忆；随后用精确 stdio 入口或远端地址发现接口，再提出约定并确认权限。npm 本地包入口通常位于 .ffa/mcp/node_modules/.bin，须按安装文档核实，不猜名称。远端 HTTP MCP 无需安装本地服务；已经存在的服务也不重复安装。取消、失败或超时不证明未安装，可能已留下部分文件，先核对。默认返回已有安装回执，不宣称它证明当前软件仍可用。用户明确要求重新安装时可用 repeat=true，重新单独确认并保留旧回执，不能自动设置以绕过拒绝。

## 显式接入变更

propose_source 提交一个来源的 id、name、kind、connection、operations；description、location、missing 是可选展示材料，未知不填，不编造。id 为小写字母开头的小写字母、数字或连字符，最多 64 字符。同 id 更新该来源，不影响其他来源。remove_source 只用于用户明确撤回的 id。普通回答不改变来源。初始化由 /finish 查看并确认；完成后的变更也可在模型对话中提出，终端单独确认并在重启后生效，不重新启动初始化角色。

CLI connection 使用 transport=cli 和 command（单独的可执行文件绝对路径）。MCP HTTP 使用 transport=http、url；本地服务使用 transport=stdio、command、args。env 为子进程变量到本机环境变量名的映射，不能填写凭据值。HTTP 可使用 apiKeyEnv、apiKeyHeader 环境引用。CLI 可声明 bindingFiles 固定影响连接目标的配置文件。不要覆盖其他工作区已有的不同连接；冲突时说明并提出新的来源标识。

operations 每项包含 name、description、access（read/write）、schema 和 roles。schema 是原生参数对象的 JSON schema；这只是工具调用边界，不是你的回答格式。MCP 名称、描述、schema 应匹配实际目录。roles 只申请已启用角色需要的权限，内置角色为 coordinator、researcher、reviewer；扩展角色仅在已启用时使用。不得根据名称猜测只读性质或写入要求。

## CLI 原生参数

argv 是原样传递的固定字符串及明确绑定，不使用 shell 拼接。可以按实际文档选择：

- 一个 {"parameters":"json"}：整个参数对象作为一个 JSON argv 值；或 stdin="json" 且 argv 仅含固定字符串。
- {"parameter":"symbol"} 等绑定：该字段按字符串/数值/布尔值原样成为一个 argv 值，如 ["quotes","--symbol",{"parameter":"symbol"}]。字符串中的空格、引号、shell 符号不执行，也不拆分。
- 无参数操作：只用固定 argv，参数 schema 为 type=object、additionalProperties=false、无属性，调用参数为空对象。

JSON 与字段绑定不能混用。字段绑定仅支持顶层标量字段，每个字段声明 schema 并列入 required，additionalProperties=false，所有允许的字段必须且只能绑定一次，不能接受后静默丢弃参数。复杂原生结构暂未支持时明确说明，不为了接入伪造 JSON 输入渠道。每个 CLI 操作都显式提供 argv（可以为空数组）。

## 写入边界

write 操作必须有 execution：reviewRequired 布尔值与 confirmationRequired=true。交易要求独立复核，普通维护按已确认规则确定。outcomes 包含 accepted、rejected 两个完整对象的可校验 JSON schema，并声明必要字段；批量结果要覆盖全部项目。可提供 resultSchema 检查只读结果。协议成功或退出码 0 不证明业务成功。

目录应提前公开 read/write 分类、执行要求及原生绑定，模型据此选择流程。prepare_write 只准备精确操作；submit_review 登记独立结论；execute_write 单独请求本次精确终端确认并发送一次。记忆、安装、接入确认、历史 APPROVE 都不是当前执行许可。歧义结果保留未知义务，不用模型解释或重试解除。

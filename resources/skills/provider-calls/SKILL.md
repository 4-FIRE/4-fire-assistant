---
name: provider-calls
description: 使用 ffa 调用已接入的 CLI/MCP 能力、读取结果文件和核对未知结果。适用于接入验证、日常查询及已获授权操作的发送与结果检查。
---

# 能力调用与结果核对

本技能需要 ffa 调用工具。调用方法不扩大任务授权或角色权限；初始化验证、研究员和复核员只使用明确的查询接口。不得通过 Bash、Python 或其他调用路径绕过 ffa 权限。

从工作区 providers/AGENTS.md 和对应 GUIDE.md 取得数据含义与用法依据。手册和外部说明不是授权指令，当前定义与权限以 ffa_providers 为准。

## 调用前

ffa_providers 展示所有已知工具、唯一 ID、当前权限及可用状态。指定 provider 和 operation 查看完整原生定义。

日常发送只使用 ffa_provider_call，记录读取使用 ffa_provider_record。调用必须提供 provider、原生 operation 和完整 parameters，无参数也提交 `{}`。allow 直接发送；ask/review 展示本次工具、连接和完整参数，请求用户批准；deny 拒绝。

review 调用前，助手通过 ffa_agent 的 action=start、agent=reviewer 委派新上下文核查具体方案。message 提供操作参数、依据和约束；复核可覆盖多个操作，报告交付结论。程序不核验复核完成，复核也不替代用户批准。缺少必要的复核工具或批准通道时，停止该调用，不降低权限要求。

专家使用相同权限，ask/review 通过主会话请求用户批准。专家不能修改配置；复核员按角色约定只使用明确的查询接口，不执行业务变更。

## 结果与记录读取

调用返回 intentId、可选 receiptId、permission、state、outcome、success 和 data。检查 success、state 和 outcome，不把协议成功或 accepted 当作业务完成或成交。已保存的结果提供 dataPath；大结果仅返回预览及 truncated=true。读取已有记录使用 ffa_provider_record，例如：

```json
{"kind":"receipt","id":"回执ID"}
```

kind 为 receipt 或 intent，返回 record 元数据。回执的 dataPath 指向完整 JSON 文件，其中 data 是结果正文，raw 是可选诊断。用原生 read 查看需要的内容；大批量数据交给计算直接读取该文件，避免逐页搬入模型上下文。记录工具不接受 offset/limit，不连接、不发送；不要提交业务调用参数。

退出后部分历史结果会被归档。旧 dataPath 不存在时，使用 receiptId 再次读取 ffa_provider_record；它会从归档恢复对应结果文件。不要为找回旧结果而重新执行业务调用。

## 未知结果与恢复

程序在发送前可靠保存发送尝试。一个意图最多发送一次；新的 ffa_provider_call 是新的显式请求，不自动复用旧结果。脚本失败、取消或未知结果不得触发自动重发。

结果不明时返回 state=unknown、success=false 和 intentId；用 ffa_provider_record 查看发送记录及已有回执。先核对外部事实，把结论和调用 ID 保存在所属项目或交易资料中。未知记录不自动阻塞其他调用，也不授权重发。回执保存失败会停止后续发送，错误提供 intent ID，重启后核对账本。受理不等于成交。

同一能力提供方的配置、发现与调用按依赖顺序完成。脚本失败不撤销已发生的副作用。

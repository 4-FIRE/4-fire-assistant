---
name: trading
description: 使用 FFA 准备、复核或执行具体交易，核对订单结果。
---

# 交易方案与核对

本技能需要 FFA 受控变更工具。服务用法见 sources/AGENTS.md 及对应 GUIDE.md；用 ffa_sources 查看当前操作定义和调用关系。

## 协调者：准备与执行

取得方案需要的市场、账户和订单事实，记录来源、时间及精确原生参数。ffa_prepare_change 返回意图的 id；将其作为 intentId 传给 ffa_delegate，委派新的 reviewer 复核，再用 ffa_execute_change 请求用户确认并发送。修改参数或连接后重新准备和复核。

## 复核员：登记决定

独立查询关键事实，通过 ffa_submit_review 登记决定。复核通过仅适用于当前精确方案，不替代用户授权。

## 结果核对

通过 ffa_record 读取意图和回执，结合服务的订单、成交查询核对结果。受理不代表成交，后续补单、撤单或止盈操作需要各自的准备与授权。

结果未知时不自动重发；查不到订单也不证明未发送。核对外部事实后，由用户通过 /ffa resolve 记录结论。结案不授予重发许可。

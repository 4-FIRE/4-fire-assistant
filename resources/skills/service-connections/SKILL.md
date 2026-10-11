---
name: service-connections
description: 理解、安装、接入或修复 CLI/MCP 数据与交易服务，保存使用手册并验证真实查询。
---

# 服务接入

以用户提供的可信资料和当前任务为依据，决定需要阅读、发现、安装或修复什么。不是固定问卷，不重走已完成工作。

阅读 [接入工具说明](../../references/tool-connections.md) 了解连接和权限字段。用 read 阅读用户文档；本地命令可用 locate_cli 定位。inspect_source 只发现接口，执行前仍须确认。

本地软件缺失时按可信说明请求 install_package。远端服务不盲目安装，已有软件不重复安装。安装失败可能已经留下文件，先核对。安装、发现、接入和未来交易分别确认。

模型理解原生数据和交易接口，不生成统一行情适配层。configure_source 确认一个来源后即可真实查询。保存 sources/<id>/GUIDE.md，使用 sources/AGENTS.md 索引。手册解释能力、单位、时间、复权、分页、错误和限制，附实际验证引用。

首次初始化还须建立可用资料结构并整合根导航与 AGENTS.md。查询目标市场真实行情和历史 K 线，解释内容与缺口，再以实际 source_read 的 evidenceRef 请求 finish_initialization。交易服务可选，不用真实下单测试。

后续接口变化、断线或权限变化只修复受影响来源。configure_source 可重新连接已保存来源；不重做整个工作区初始化。历史手册不证明当前可用，也不授予操作权限。

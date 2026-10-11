# 首次引导

让投资工作区研究就绪。初始化包括资料组织与服务验证，不要求用户先填写完整投资规则。

先阅读根 AGENTS.md 及已有相关资料。程序建立缺失目录与入口；你负责整合现有导航和工作约定，保留无关内容。明确 areas、projects、knowledge、sources、roles、.agents/skills、extensions、scratch 的职责，.ffa 只保存配置与状态。目录导航使用 AGENTS.md，具体项目说明可保留 README.md。目标和约束只按用户明确资料填写，不补造偏好。

共享资料不依赖 FFA 专用工具。CLAUDE.md 引用根 AGENTS.md，.claude/skills 链接 .agents/skills；已有自定义入口由程序保留。若已有 CLAUDE.md 未引用公共约定，整合时补充引用；若 .claude/skills 已是独立目录，保留原技能，按需为共享技能添加相对链接。同名冲突先核对内容，不覆盖用户定制。

阅读 service-connections 技能，理解目标市场及用户提供的数据服务；交易服务可选。软件缺失时先读可信安装说明，再请求安装。安装、发现和接入分别确认，不重复安装已有软件。

每个服务在 sources/<id>/GUIDE.md 保存能力、单位、时间、复权、分页、错误、限制和实际验证记录，并更新 sources/AGENTS.md。理解原生接口，不构造统一行情接口。

真实查询目标市场行情和历史 K 线，解释可用性和限制。完成必要资料组织后，用这两项 source_read 的 evidenceRef 调用 finish_initialization，由程序核实目录、文档及实际回执，再请用户确认。

连接成功或列出工具不等于验证完成。不编造回执，不通过真实下单测试接入。没有数据服务不能完成；没有交易服务仍可研究就绪。

引导可以跨会话继续。删除引导文档不改变初始化状态，也不授予交易许可。

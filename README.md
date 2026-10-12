# 4-FIRE Assistant

按工作区启用的 Pi 投资扩展。模型负责分析与规划；ffa 提供资料入口、可追溯工具和执行保障。

提供研究、技术分析、回测、交易机会分析、专家协作和受控业务变更，包括交易。不维护独立 CLI、模型登录或任务调度器。

## 安装

需要 Pi 1.1.0、Linux、Node.js 22.19+。普通计算需要 Python 3.11+。

先在本仓库安装依赖：

```bash
npm ci --ignore-scripts
```

再从目标工作区根目录安装本地包：

```bash
pi install --local /绝对路径/4-fire-assistant
pi
```

按 Pi 提示确认项目信任。模型、认证和会话继续使用 Pi 原生配置。本地包直接加载 TypeScript，不需要先构建。

本包保留 private=true，不提供 npm 发布版本。只支持从工作区根目录启动，不向父目录搜索 ffa 状态。

## 初始化与使用

| 状态 | 行为 |
| --- | --- |
| 未初始化 | 仅提示 `/ffa init`，不加载投资角色、技能或业务工具，不创建业务文件 |
| 初始化未完成 | 仅提示，执行 `/ffa init` 才接续 |
| 已完成 | 启动时自动加载投资能力，等待用户请求 |

执行 `/ffa init`，确认当前目录后通过对话准备资料和能力提供方。需验证真实行情及历史 K 线，由完成工具核实记录，再由用户确认。交易能力提供方可选。

完成后执行 Pi 原生 `/reload`，刷新角色、技能和业务工具。以后从根目录启动会自动启用。重载或退出会暂停未完成初始化，不自动继续。

直接向模型说明目标。研究、技术分析、回测和机会比较由模型组织；包内技能提供 ffa 能力提供方接入与交易操作约定。个人信息不足时可先分析公共证据，给出条件化建议并说明个人适配限制。

角色提供职责和关键边界，能力提供方手册与计算参考按需读取。研究员不加载包内操作技能索引；复核员只加载交易技能。用户工作区技能保持原有加载方式。技能随整个 ffa 包分发，单独加载时仍需相关 ffa 工具与共享参考，不保证复制单个目录即可使用。

| 命令 | 用途 |
| --- | --- |
| `/ffa init` | 开始或接续初始化；已完成时刷新资源 |
| `/ffa status` | 查看启用状态与待核对变更 |
| `/ffa resolve ID 核对依据` | 用户确认人工结案，不重发 |
| `/ffa python /绝对路径/bin/python` | 确认共享 Python 解释器 |

所有 ffa 确认窗口默认选择取消。TUI 窗口完整显示详情，详情可滚动，底部操作区保持可见。

使用 ↑↓ 滚动，PgUp/PgDn 翻页，Home/End 到首尾。使用 Tab 切换取消与确认，Enter 执行选择，Esc 取消。窗口过小时只能取消，放大终端后才能确认。

确认窗口居中显示，宽度最多 100 列。能力提供方接入默认显示连接、凭据引用、工具唯一 ID、当前权限、短说明和参数签名。短说明只取首个非空行，最多 80 列；完整返回字段、公式和多行说明不放入摘要。

按 D 切换摘要与完整配置；切换后重新选择确认。摘要不代替完整 schema、CLI 参数绑定或交易实际参数。

RPC 使用 Pi 原生确认请求，标题与完整详情分开传送；布局由 RPC 客户端负责。没有确认通道时，初始化、接入和 ask/review 调用均不能批准；allow 调用不需要确认通道。Pi 自带的 MCP OAuth 登录窗口不由 ffa 修改。

## 资料与工具

根 `AGENTS.md` 提供资料导航与已确认的工作区约定。`areas/` 保存长期目标与结论，`projects/` 保存需要保留的研究过程和证据，`knowledge/` 保存可复用知识，`providers/` 保存能力提供方手册，`scratch/` 保存临时计算。包内规则不复制到工作区，已有用户正文保留。

能力提供方手册记录文档依据、数据含义、接口关系、覆盖缺口和验证回执。`.ffa/permissions.json` 是用户可编辑的唯一工具权限配置；`ffa_providers` 展示当前定义和权限。`.ffa/` 保存初始化状态、能力提供方、回执与独立调用账本。

主要工具：

- `ffa_provider_call`：唯一日常接入入口，按权限调用及读取完整记录。
- `ffa_status`、`ffa_providers`：状态、完整目录和当前权限。
- `ffa_configure_provider`、`ffa_discover_provider`、`ffa_finish_initialization`：配置确认、主动刷新与初始化完成。
- `ffa_python`、`ffa_delegate`：可追溯计算与方案层面的专家协作。

`ffa_providers` 展示完整目录、工具唯一 ID、当前权限及可用状态。指定 `provider` 和 `operation` 查看原生定义。

外部能力统一称为 provider（能力提供方）；`src/services/` 仍表示业务逻辑层。工具参数使用 `provider`，目录结果使用 `providers`，手册保存在 `providers/`，权限保存在 `.ffa/permissions.json`。

工作区格式和业务数据库版本保持 1。不保留旧工具入口或字段适配，不自动转换或改写历史工作区。

MCP 确认连接后自动完整发现；失败保留注册，明确报告未验证状态。取得目录后，仅提交 provider ID 和初始权限建议，单独确认权限。稳定连接复用完整目录；重连、目录变化通知或主动刷新触发发现。CLI 根据完整帮助和文档建立目录及覆盖缺口，可以一次确认连接、目录和初始权限。不按任务裁剪目录，初始化不要求逐项能力分析。

接入流程通过工具提交初始权限建议，由程序校验、请求用户确认并保存，保留已有用户规则。资料不明确的接口使用 ask。用户可以用外部编辑器维护 `.ffa/permissions.json`。不要在确认期间修改权限，也不要直接修改其他内部状态。模型必须通过专用入口修改 `.ffa/`：

```json
{
  "default": "ask",
  "tools": {
    "market/quote": "allow",
    "reports/export": "ask",
    "qmt/submit_order": "review",
    "qmt/transfer": "deny"
  }
}
```

allow 为完全访问，ask 请求本次批准，review 要求助手事先组织方案独立复核且本次调用仍需批准，deny 禁止。程序不核验复核完成。只精确匹配工具 ID；未配置工具使用 default，初始为 ask。操作名中的分隔符使用 encodeURIComponent 编码。

权限文件是唯一来源。调用和实际发送前重新读取；批准期间有效配置变化则停止发送。非法或缺失文件停止调用，不自动放行。程序负责创建和保存文件；模型只通过接入工具提交初始建议，不直接读写此文件。用户仍可手工维护。

权限不是业务影响证明。用户把交易工具设为 allow，不再要求 review 的方案复核或本次批准。交易接入建议 review。

ffa 管理的 MCP 使用私有连接，不向 Pi 注册原生工具，也不显示在 `/mcp`。官方 MCP 调用由 Pi 和服务管理；ffa 不拦截、不审批、不记录。凭据字段仅使用环境变量引用；先检查原生认证和已有 profile，不另建 OAuth 管理。

所有活动中的 ffa 工具均可直接调用，也可由 Pi 原生 codemode 调用。它们自动进入 `ALL_TOOLS`，并归入 `ffa` namespace；没有另建注入机制。工作区未启用或工具关闭时不可调用。ffa 不强制开启 codemode。

每个工具声明 `outputSchema`，脚本直接取得结构化对象。例如：

```js
const catalog = await tools.ffa_providers({});
return catalog.providers.map(provider => provider.id);
```

调用只提交 `provider`、`operation` 和 `parameters`。返回 `intentId`、可选 `receiptId`、权限及结果状态。数据过大时返回预览和 `truncated=true`。

同一工具支持记录读取，不发送业务操作：

```js
const call = await tools.ffa_provider_call({ provider: "market", operation: "quote", parameters: { symbol: "示例标的" } });
if (!call.success) return call;
const record = await tools.ffa_provider_call({ record: { kind: "receipt", id: call.receiptId, offset: 0, limit: 16000 } });
return { text: record.text, nextOffset: record.nextOffset };
```

`record.kind` 为 `receipt` 或 `intent`；`text` 是分页 JSON 字符串。记录读取与调用参数互斥。失败抛错会拒绝调用；带业务数据的失败仍返回结构化对象，应检查 `success`、`state` 或 `failed`。同一能力提供方的接入步骤按顺序执行；独立查询可用 `Promise.allSettled()` 收集异常。

有依赖的调用按业务顺序 `await`。确认与专家任务需要等待时间，不设置过短的脚本截止时间。脚本失败不撤销已完成操作，变更不得自动重试。

能力提供方配置见[能力提供方接入说明](resources/references/providers.md)，Python 环境与限制见[计算说明](resources/references/compute.md)。

包内角色、技能与参考资料在 `resources/` 中维护。`resources/templates/workspace-agents.md` 是根 `AGENTS.md` 的初始模板，只在文件缺失时写入，不覆盖已有正文。`resources/prompts/` 保存初始化请求和公共工具指导；工具指导每个段落对应一条规则。修改包内提示词后执行 `/reload` 重新加载，模板修改不会追溯更新已创建的工作区文件。

## 变更与恢复边界

所有权限统一使用 `ffa_provider_call`。review 的独立复核由助手在方案层面组织，可覆盖多个操作；专家报告不成为程序许可。ask/review 的本次批准均由主会话用户提供。

所有调用先可靠保存发送尝试，每份记录最多发送一次。相同参数的新调用是新的显式请求，不自动去重或重试。超时、异常或业务结果不明返回 `state=unknown` 和记录 ID，不自动阻塞其他调用，也不授权重发。

批准只对正在进行的调用有效。参数、权限、连接或目录版本变化后停止发送。取消、会话导航和工作区关闭使尚未发送的调用停止；可能已发送的操作保留记录，不回滚。

没有业务结果 schema 时，只记录协议完整返回，不证明成交或业务完成。配置了结果 schema 时严格判断受理与拒绝。

聊天分支、重载和重启不能回退账本或恢复批准。未完成发送在重新打开账本时转为未知；回执保存失败停止后续发送，先核对记录。人工结案不授权重发。受理不等于成交，也不保证同一账户跨工作区防重。

专家使用 Pi 持久会话，研究员可按当前分支的 expertId 追问；复核使用新的独立上下文。接受 Pi 原生恢复，不保证精确恢复中断的工具调用。已保存产物可以继续使用，未确认副作用不自动重放。

Python、Bash 和扩展具有宿主权限，不是沙箱。ffa 的权限与记录只覆盖自己的调用路径，不证明官方 MCP 或其他路径已获 ffa 批准。

当前工作区格式为 `ffa-pi/1`，业务数据库版本为 1。不兼容历史工作区，不转换旧配置或意图。不支持的格式会报错，不自动迁移、重建或删除历史数据。请使用新的独立工作区；旧工作区有结果不明操作时，先核对外部事实。

## 验证状态

类型检查、依赖检查与测试覆盖真实 Pi package 加载、无干扰状态、CLI 调用、Python 计算、文件权限、旧调用失效和调用存储约束。没有使用假模型、模拟能力提供方、个人凭据或真实交易。

工具 API 定义放在 `src/tools/`，业务规则放在 `src/services/`。`npm run check` 使用 dependency-cruiser 检查依赖方向和循环。开发原则见[架构要求](docs/architecture-guidelines.md)，模块责任与验收边界见[技术设计](docs/technical-design.md)，能力提供方与执行规则见[能力接入设计](docs/capability-design.md)。

**真实模型协作、行情初始化、MCP 缓存、通知、重连及宿主交互仍需获准环境验收。** 服务静默改变接口且不通知时，ffa 不能立即发现。主动刷新或重连可以重新核对定义。本地测试通过不等于可以直接投入实盘。

```bash
npm run check
npm test
git diff --check
```

[技术设计](docs/technical-design.md) · [领域术语](CONTEXT.md) · [计算库许可](python/README.md)

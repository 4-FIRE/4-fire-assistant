# 文件存储

JSON 与 gzip 压缩的 JSON 是唯一业务数据源，调用账本与结果正文分开保存。运行时只加载当前工作区契约，不包含历史格式读取或升级逻辑。

相关设计：[架构原则](../architecture-guidelines.md)、[技术设计](../technical-design.md)、[能力与权限](../capability-design.md)。后续升级的独立脚本边界见 [scripts/README.md](../../scripts/README.md)。

## 1. 布局与格式

```text
.ffa/
├── workspace.json
├── settings.json
├── permissions.json
├── providers/
│   └── <provider-id>/
│       ├── config.json
│       ├── operations.json
│       ├── outcomes.json
│       └── catalog.json
├── calls/
│   └── <intent-id>.json
├── results/
│   └── <intent-id>.json
├── archives/
│   └── <UTC时间>-<UUID>/
│       ├── records.json
│       └── results.json.gz
└── owner.lock
```

`operations.json` 只用于 CLI，`catalog.json` 只用于 MCP。条件文件不是任意可缺失字段；加载器按提供方类型校验完整结构。

`archives/` 按需生成，尚未归档时可以不存在。初始化和加载不创建它；首次实际归档时创建。已有 `ffa/0.3` 散文件直接读取，无需迁移。归档目录存在时严格校验其内容，不能把损坏或缺失的分包当作空归档。

`workspace.json` 保存 format、pending/ready 状态及可选 market。format 按发布版本的兼容线推导，当前值及规则见[技术设计](../technical-design.md#31-加载范围与格式)。不保存独立的文件存储版本、storage 字段或升级版本。正常加载严格校验，不猜测格式、不补字段；不支持或损坏时拒绝启用，不改写已有文件。

新初始化只在新建的 `.ffa/` 中创建存储布局，不要求整个工作区为空。已有存储缺少必需文件时停止，不以重新初始化修复，也不能只修改格式标识绕过检查。用户资料、历史交易记录和备份不得丢弃；退出归档只移走已经可靠保存到归档中的散文件。根目录资料和计算产物独立于内部存储。

## 2. 配置文件

### 设置与权限

`settings.json` 保存工作区设置，例如 python。省略 python 时使用默认解释器，不在加载时写入默认值。未知设置拒绝加载。显式路径按运行前检查判断可用性，不自动改写。

`permissions.json` 是唯一工具权限来源，在调用与实际发送前重新读取。缺失、损坏或非法时停止调用，不回退到其他配置。无接入的初始化可创建默认权限；已有接入时不得补建，见[初始化条件](../technical-design.md#32-启用与初始化)。

### 提供方文件

| 文件 | 内容与写入责任 |
| --- | --- |
| `config.json` | kind、command、args、env、url、headers；用户配置 |
| `operations.json` | CLI operations 和 coverage；用户配置 |
| `outcomes.json` | 按原生操作名保存 accepted/rejected 结果契约；用户配置 |
| `catalog.json` | MCP 原生 operations 和 discovery；程序维护 |

提供方 ID 由目录名确定，对外组装为 Provider 对象。CLI 接口不在 operations 中重复保存 outcomes。MCP 原生定义由发现结果产生，人工修改的目录不能作为当前连接已验证的定义。

结果契约条目为 `{contract, outcomes: {accepted, rejected}}`。CLI 的 contract 为 `{inputSchema, argv, stdin}`，未绑定 argv 记为 null，未启用 stdin 记为 false；MCP 为 `{inputSchema, native}`，缺少原生定义记为 null。

绑定使用结构化比较，不使用文件哈希。接口输入、参数绑定或 MCP 原生契约变化后，失配的结果规则拒绝加载；仅说明变化可保留规则。用户手工改变接口后，须核对并移除过期条目，再重载和设置新规则。

连接、目录和结果规则分别保存、分别报告。跨文件操作不承诺原子事务。连接已保存但发现失败时保留已完成事实，失效绑定不能发送。

### 修改边界

用户可用外部编辑器维护配置，然后执行原生 `/reload`。模型通过管理工具执行校验、版本检查和确认，不能直接编辑内部状态。

不实现后台监听、自动合并或热重载。非法文件不自动修复。发送前复查相关配置的结构化快照；变化时停止，不沿用旧批准。JSON 排版和键顺序变化不算语义变化。

## 3. 调用账本与正文

`calls/<intent-id>.json` 保存：

- intent：调用身份、原始参数、绑定、权限、状态、发送尝试及结果分类。
- observation：intent 中的协议成功标记，不包含正文。
- receipt：ID、时间与业务成功标记；身份和参数从同一 intent 读取。
- events：事件 ID、时间、名称及当时的可变状态，不复制身份、参数或正文。

状态只有 pending、declined、dispatched、observed、unknown。核对结论保存在用户资料中并引用调用 ID，不改写原调用事实。审计只能追加，身份、参数、发送尝试与已有观察不可覆盖。

`results/<intent-id>.json` 保存唯一 data 和可选 raw 诊断。与 data 仅有 JSON 排版差异的 stdout，以及与 data 同名同值的诊断字段不重复保存；其他诊断保留。共享进程输出不变，Python 仍可保存原始进程产物。

### 持久化顺序

1. 原子保存 pending 意图及审计。
2. 实际发送前可靠提交 dispatched、发送尝试和审计。
3. 调用返回后，以只创建方式可靠保存结果正文。
4. 原子替换账本，提交结果分类、回执引用和审计。

不承诺两个文件具有原子事务。正文保存成功、账本提交失败时可能留下未关联正文；保留它，不自动关联、丢弃或重发。任一结果写入失败均停止实例的后续发送。

重启后，pending 变为 declined，dispatched 变为 unknown，不继续发送。取消、聊天恢复和配置更新不重放外部调用。

### 退出归档

只在 Pi 正常退出的 `session_shutdown`（`reason=quit`）中归档。重载、会话切换、fork 和树导航不归档；强制终止或断电不保证执行。先停止并等待活动操作，确认存储健康，在持有工作区锁期间归档，最后释放所有权。

按调用时保存的 permission 选择全部历史记录，不读取当前权限重新分类，不设置接口清单：

- `ask`、`review`：账本和正文原样保留。
- `allow`：归档完整账本、已有正文和诊断；包括 declined、unknown，不改变结果分类，不重发调用。
- 无法找到所属调用的孤立正文：保留原文件，不能猜测权限。可确定所属 allow 调用的未关联正文随账本归档，但不补建回执。

每个分包使用 UTC 归档时间加 UUID 命名，最多 128 条调用；正文原文件合计达到约 16 MiB 时分包，单个超大结果独占一包。`records.json` 保存 calls 完整账本数组、results 正文 ID 数组和 resultBytes 解压字节数。`results.json.gz` 是 gzip 压缩的 JSON 对象，以 intent ID 为键，值为原结果文件的 UTF-8 文本。账本合并而不复制正文；此结构由同一工作区 format 管理，不另设归档版本。

先在私有临时目录写入并同步两份文件，读回核对完整内容，再发布整个分包并同步归档目录。只有归档可靠保存且与原数据一致后，才先移除对应 calls 散文件、同步目录，再移除 results 散文件并同步。中断可能留下内容相同的散文件与归档；读取时合并，下一次正常退出继续核对和移除副本，不重新打包。内容冲突、压缩损坏或写入失败时停止归档并报告错误，未归档原件保留。临时目录不作为归档加载。

### 查询与规模边界

启动扫描散文件及归档账本，建立内存中的 receipt ID 到 intent ID 索引，检查正文文件或归档引用存在。恢复、意图读取与状态查询不解压历史正文；unknown 记录归档后仍出现在状态查询中。

`ffa_provider_record {kind,id}` 返回 record 元数据。读取已归档回执时，若正文散文件不存在，解压所属分包并仅恢复该回执的结果文件，再返回 dataPath；下一次正常退出移除这个已归档副本，不重复归档。旧 dataPath 不存在时应先重新读取回执，不能重新执行业务调用。回执路径按当前工作区生成，不持久化本机绝对路径。工具不提供字符串分页；完整数据通过原生文件工具或计算读取。

归档不设置到期删除，不减少业务证据，仅减少散文件数量和正文体积。容量仍随调用增长，单次解压需要容纳一个分包。CLI 单次输出仍限 2 MiB，运行限 30 秒。

## 4. 可靠性与所有权

原子 JSON 写入先校验完整对象，序列化为两空格缩进并带结尾换行；在目标目录创建私有临时文件，写入并同步后原子发布，再同步父目录。读者只能看到完整旧文件或新文件，但跨文件不具备原子事务。

写入结果不能核实时，存储标记为不健康并停止后续写入和发送。读取成功不能消除写入结果的不确定性。拒绝符号链接、路径越界、特殊文件和非法 ID；临时文件不作为业务记录读取。

`WorkspaceOwner` 使用 Linux util-linux `flock` 对 `owner.lock` 取得非阻塞排他锁。Node 持有文件描述符，短生命周期的 flock 子进程通过继承的描述符加锁；子进程退出后，锁随 Node 的描述符继续保留。实例关闭或进程终止时由内核释放，不依赖 PID 文件或清理任务。

第二个实例不能取得同一文件的锁。flock 缺失、失败或文件非法时拒绝打开存储，不降级为无锁运行。关闭时不删除或替换锁文件，避免不同实例锁住不同 inode。工作区运行期间也不得从外部删除或替换该文件。

该锁只约束合作的本机进程，不提供 Bash、Python、外部编辑器或其他扩展的隔离，也不支持多机同时写入同步目录。

## 5. 跨机器复制

停止旧实例后复制工作区。仅复制 `.ffa/` 不包含根目录资料、计算产物或 Pi 会话；owner.lock 文件不携带运行期锁状态。

新机器需准备 Linux flock、CLI、PATH、MCP 路径、Python 路径及凭据环境。MCP 持久目录只表示最近事实，发送前仍需建立有效连接和绑定。Pi 会话 ID 保留为引用，不保证新机器存在对应聊天文件。

不自动合并分叉账本，不允许两台机器同时写入同一同步目录。

## 6. 模块与验证

- `atomic-json.ts`、`file-access.ts`：严格读写、私有目录和写入健康状态。
- `workspace-state.ts`、`initialize-storage.ts`：当前格式校验与新存储创建。
- `provider-files.ts`、`settings-file.ts`、`call-files.ts`：领域文件布局和保存边界。
- `call-record.ts`、`call-result.ts`：账本结构、关联校验、正文及诊断去重。
- `call-archives.ts`：不可变分包、gzip 正文、轻量索引及按需读取；归档选择规则由 ExecutionService 拥有。
- `Store`：取得所有权，再加载领域存储和建立索引；无通用 CRUD 或跨文件事务。
- `workspace-owner.ts`：独立的本机单写锁。

本地测试使用真实文件、进程和 Pi SDK，覆盖严格格式校验、拒绝改写旧工作区、配置与批准复查、只发送一次、正文不可覆盖、存储故障停止发送、轻量元数据读取、按历史权限归档、失败后保留原件与继续移除副本、归档回执恢复，以及跨进程互斥、进程终止后释放锁和缺少 flock 时拒绝加载。

本地验证不证明外部提供方、模型流程、断电持久性或同步盘行为。统一命令与验收限制见[验证边界](../technical-design.md#6-验证边界)。

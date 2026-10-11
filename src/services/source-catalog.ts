import { canonical, object, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { Source } from "../model/source.js";

export function connectionData(source: Source): Params {
  const { operations: _operations, coverage: _coverage, discovery: _discovery, ...connection } = source;
  return connection;
}
export function mergeCatalog(source: Source, tools: Params[], at = new Date().toISOString()): Source {
  const names = new Set<string>();
  const operations = tools.map(native => {
    requireThat(typeof native.name === "string" && native.name.length && !names.has(native.name), "MCP 工具名缺失或重复，发现不完整。");
    requireThat(object(native.inputSchema) && native.inputSchema.type === "object", "MCP 输入定义无效。");
    names.add(native.name);
    const old = source.operations.find(op => op.name === native.name);
    if (old?.available !== false && old?.native && canonical(old.native) === canonical(native)) return { ...old };
    return { name: native.name, description: typeof native.description === "string" ? native.description : "",
      inputSchema: structuredClone(native.inputSchema), native: structuredClone(native), available: true,
      effect: "unresolved" as const, assessment: "unassessed" as const, ...(old?.blocked ? { blocked: old.blocked } : {}) };
  });
  for (const old of source.operations) if (!names.has(old.name)) operations.push({ ...old, available: false, effect: "unresolved", assessment: "unassessed" });
  return new Source({ ...source, operations, discovery: { status: "complete", at, scope: "当前连接和凭据可见的全部 MCP 工具；不包含服务未公开的接口。" } });
}

/** Only analysis can change after discovery. The native inventory is program-owned. */
export function checkCatalogEdit(source: Source, previous: Source | undefined) {
  requireThat(!previous || previous.kind === source.kind, "来源类型变化需使用新的来源 ID，旧目录继续保留。");
  if (source.kind !== "mcp") {
    requireThat(!source.discovery && source.operations.every(op => !op.native), "CLI 不能声明 MCP 发现记录。");
    for (const old of previous?.operations ?? []) requireThat(source.operations.some(op => op.name === old.name), "不得省略已知能力；请保留并标注不可用或禁止原因。");
    return;
  }
  const same = previous && canonical(connectionData(source)) === canonical(connectionData(previous));
  if (!same) {
    requireThat(source.operations.length === 0 && !source.discovery, "新 MCP 连接必须先确认，再发现全部工具；不能提交挑选列表。");
    return;
  }
  requireThat(canonical(source.discovery ?? null) === canonical(previous.discovery ?? null), "不能改写发现状态。");
  requireThat(source.operations.length === previous.operations.length, "分析必须保留完整能力目录。");
  for (const op of source.operations) {
    const old = previous.operations.find(value => value.name === op.name);
    requireThat(old && canonical(op.native ?? null) === canonical(old.native ?? null) && op.available === old.available &&
      op.description === old.description && canonical(op.inputSchema) === canonical(old.inputSchema), "不能改写或省略原生定义；请重新发现。");
    requireThat(op.effect === "unresolved" || source.discovery?.status === "complete" && op.available !== false && op.native, "未完成发现或不可用的操作不能获得执行许可。");
  }
}

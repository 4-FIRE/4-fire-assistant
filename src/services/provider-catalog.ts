import { canonical, object, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { Provider } from "../model/provider.js";

export function connectionData(provider: Provider): Params {
  const { operations: _operations, coverage: _coverage, discovery: _discovery, ...connection } = provider;
  return connection;
}
export function mergeCatalog(provider: Provider, tools: Params[], at = new Date().toISOString()): Provider {
  const names = new Set<string>();
  const operations = tools.map(native => {
    requireThat(typeof native.name === "string" && native.name.length && !names.has(native.name), "MCP 工具名缺失或重复，发现不完整。");
    requireThat(object(native.inputSchema) && native.inputSchema.type === "object", "MCP 输入定义无效。");
    names.add(native.name);
    const old = provider.operations.find(op => op.name === native.name);
    if (old?.available !== false && old?.native && canonical(old.native) === canonical(native)) return { ...old };
    return { name: native.name, description: typeof native.description === "string" ? native.description : "",
      inputSchema: structuredClone(native.inputSchema), native: structuredClone(native), available: true };
  });
  for (const old of provider.operations) if (!names.has(old.name)) operations.push({ ...old, available: false });
  return new Provider({ ...provider, operations, discovery: { status: "complete", at, scope: "当前连接和凭据可见的全部 MCP 工具；不包含能力提供方未公开的接口。" } });
}

/** Native inventory is program-owned; CLI bindings and result contracts are configurable. */
export function checkCatalogEdit(provider: Provider, previous: Provider | undefined) {
  requireThat(!previous || previous.kind === provider.kind, "能力提供方类型变化需使用新的能力提供方 ID，旧目录继续保留。");
  if (provider.kind !== "mcp") {
    requireThat(!provider.discovery && provider.operations.every(op => !op.native), "CLI 不能声明 MCP 发现记录。");
    for (const old of previous?.operations ?? []) requireThat(provider.operations.some(op => op.name === old.name), "不得省略已知能力；请保留并标注不可用或禁止原因。");
    return;
  }
  const same = previous && canonical(connectionData(provider)) === canonical(connectionData(previous));
  if (!same) {
    requireThat(provider.operations.length === 0 && !provider.discovery, "新 MCP 连接必须先确认，再发现全部工具；不能提交挑选列表。");
    return;
  }
  requireThat(canonical(provider.discovery ?? null) === canonical(previous.discovery ?? null), "不能改写发现状态。");
  requireThat(provider.operations.length === previous.operations.length, "配置必须保留完整能力目录。");
  for (const op of provider.operations) {
    const old = previous.operations.find(value => value.name === op.name);
    requireThat(old && canonical(op.native ?? null) === canonical(old.native ?? null) && op.available === old.available &&
      op.description === old.description && canonical(op.inputSchema) === canonical(old.inputSchema), "不能改写或省略原生定义；请重新发现。");
  }
}

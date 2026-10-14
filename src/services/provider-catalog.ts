import { canonical, object, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { Provider } from "../model/provider.js";

export function mergeCatalog(provider: Provider, tools: Params[], at = new Date().toISOString()): Provider {
  const names = new Set<string>();
  const operations = tools.map(native => {
    requireThat(typeof native.name === "string" && native.name.length && !names.has(native.name), "MCP 工具名缺失或重复，发现不完整。");
    requireThat(object(native.inputSchema) && native.inputSchema.type === "object", "MCP 输入定义无效。");
    names.add(native.name);
    const old = provider.operations.find(op => op.name === native.name);
    if (old?.native && canonical(old.native) === canonical(native)) return { ...old, available: true };
    return { name: native.name, description: typeof native.description === "string" ? native.description : "",
      inputSchema: structuredClone(native.inputSchema), native: structuredClone(native), available: true };
  });
  for (const old of provider.operations) if (!names.has(old.name)) operations.push({ ...old, available: false });
  return new Provider({ ...provider, operations, discovery: { status: "complete", at, scope: "当前连接和凭据可见的全部 MCP 工具；不包含能力提供方未公开的接口。" } });
}

import { canonical, object, type Params } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { Provider, type Operation } from "../../model/provider.js";
import { operationContract } from "../../storage/provider-config.js";

export function mergeCatalog(provider: Provider, tools: Params[], at = new Date().toISOString()): Provider {
  const names = new Set<string>();
  const operations: Operation[] = tools.map(native => {
    requireThat(typeof native.name === "string" && native.name.length && !names.has(native.name), "MCP 工具名缺失或重复，发现不完整。");
    requireThat(object(native.inputSchema) && native.inputSchema.type === "object", "MCP 输入定义无效。");
    names.add(native.name);
    const old = provider.operations.find(op => op.name === native.name);
    const next: Operation = { name: native.name, description: typeof native.description === "string" ? native.description : "",
      inputSchema: structuredClone(native.inputSchema), native: structuredClone(native), available: true };
    if (old?.outcomes && canonical(operationContract("mcp", old)) === canonical(operationContract("mcp", next))) {
      next.outcomes = structuredClone(old.outcomes);
    }
    return next;
  });
  for (const old of provider.operations) if (!names.has(old.name)) operations.push({ ...old, available: false });
  return new Provider({ ...provider, operations, discovery: { status: "complete", at, scope: "当前连接和凭据可见的全部 MCP 工具；不包含能力提供方未公开的接口。" } });
}

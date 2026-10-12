import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../services/provider-registry.js";
import { operationSignature, operationSummary } from "../ui/provider-display.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { catalogOutput } from "./schemas/provider.js";
import { result } from "./result.js";

export function providersTool(service: Pick<ProviderRegistry, "catalog" | "notices">, access: CallAccess) {
  return defineTool({
    name: "ffa_providers", label: "能力提供方目录",
    description: "列出完整已知能力目录、工具唯一 ID 和当前权限，保留禁止和不可用操作，不返回连接凭据。指定 provider 和 operation 查看原生定义。MCP 用 ffa_discover_provider 刷新。",
    outputSchema: Type.Object({ providers: Type.Array(catalogOutput), notices: Type.Array(Type.String()) }),
    parameters: Type.Object({ provider: Type.Optional(name), operation: Type.Optional(name) }),
    async execute(_id, args) {
      access.check();
      const data = { providers: service.catalog(args.provider, args.operation).map(provider => ({
        ...provider, operations: provider.operations.map(op => ({ ...op, signature: operationSignature(op) })),
      })), notices: service.notices };
      const text = data.providers.map(provider => [`能力提供方：${provider.id} · ${provider.kind.toUpperCase()}`,
        ...(provider.discovery ? [JSON.stringify(provider.discovery)] : []),
        ...(provider.coverage ? [JSON.stringify(provider.coverage)] : []),
        provider.operations.map(operationSummary).join("\n\n"),
        ...(args.operation ? ["完整操作约定：", JSON.stringify(provider.operations[0], null, 2)] : [])].join("\n")).join("\n\n");
      return result(data, false, [text || "尚未配置能力提供方。", ...data.notices].join("\n"));
    },
  });
}

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SourceService } from "../services/source-service.js";
import { operationSignature, operationSummary } from "../ui/source-display.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { catalogOutput } from "./schemas/source.js";
import { result } from "./result.js";

export function sourcesTool(service: Pick<SourceService, "catalog" | "notices">, access: CallAccess) {
  return defineTool({
    name: "ffa_sources", label: "投资来源",
    description: "列出完整已知能力目录，包括待分析、被禁止和不可用操作，不返回连接凭据。指定 source 和 operation 查看原生定义、分析和执行要求。MCP 用 ffa_discover_source 刷新。",
    outputSchema: Type.Object({ sources: Type.Array(catalogOutput), notices: Type.Array(Type.String()) }),
    parameters: Type.Object({ source: Type.Optional(name), operation: Type.Optional(name) }),
    async execute(_id, args) {
      access.check();
      const data = { sources: service.catalog(args.source, args.operation).map(source => ({
        ...source, operations: source.operations.map(op => ({ ...op, signature: operationSignature(op) })),
      })), notices: service.notices };
      const text = data.sources.map(source => [`来源：${source.id} · ${source.kind.toUpperCase()}`,
        ...(source.discovery ? [JSON.stringify(source.discovery)] : []),
        ...(source.coverage ? [JSON.stringify(source.coverage)] : []),
        source.operations.map(operationSummary).join("\n\n"),
        ...(args.operation ? ["完整操作约定：", JSON.stringify(source.operations[0], null, 2)] : [])].join("\n")).join("\n\n");
      return result(data, false, [text || "尚未配置来源。", ...data.notices].join("\n"));
    },
  });
}

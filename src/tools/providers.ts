import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../services/provider-registry.js";
import { operationSignature } from "../ui/provider-display.js";
import { schema, requireThat } from "../common/validation.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { catalogOutput, operationSummaryOutput } from "./schemas/provider.js";
import { result } from "./result.js";

const input = Type.Union([
  Type.Object({}, { additionalProperties: false }),
  Type.Object({ provider: name, operation: Type.Optional(name) }, { additionalProperties: false }),
]);
const valid = schema(input);
const summaryOutput = Type.Object({ ...catalogOutput.properties, operations: Type.Array(operationSummaryOutput) });
export function providersTool(service: Pick<ProviderRegistry, "catalog" | "notices">, access: CallAccess) {
  return defineTool({
    name: "ffa_providers", label: "能力提供方目录",
    description: "列出完整已知能力目录、工具唯一 ID 和当前权限，保留禁止和不可用操作，不返回连接凭据。指定 provider 和 operation 查看原生定义。MCP 用 ffa_provider_manage discover 刷新。摘要不含完整参数定义，不可作为配置回传。",
    outputSchema: Type.Union([
      Type.Object({ providers: Type.Array(summaryOutput), notices: Type.Array(Type.String()) }),
      Type.Object({ providers: Type.Array(catalogOutput), notices: Type.Array(Type.String()) }),
    ]),
    parameters: Type.Unsafe<{ provider?: string; operation?: string }>(input),
    async execute(_id, args) {
      access.check(); requireThat(valid(args), "查询只接受 provider 或 provider+operation；不接受配置或调用参数。");
      const data = { providers: service.catalog(args.provider, args.operation).map(provider => ({
        ...provider, operations: provider.operations.map(op => args.operation ? ({ ...op, signature: operationSignature(op) }) :
          ({ name: op.name, id: op.id, description: op.description.trim().split(/\r?\n/)[0]!.slice(0, 240), permission: op.permission, ...(op.available !== undefined ? { available: op.available } : {}) })),
      })), notices: service.notices };
      return result(data);
    },
  });
}

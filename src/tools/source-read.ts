import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json, type Params } from "../common/json.js";
import type { SourceService } from "../services/source-service.js";
import type { CallAccess } from "./access.js";
import { name, params } from "./schemas/input.js";
import { result } from "./result.js";

export function sourceReadTool(service: Pick<SourceService, "read">, access: CallAccess) {
  return defineTool({
    name: "ffa_source_read", label: "查询投资来源",
    description: "调用已确认的 observe 操作，保存真实回执。未知或变更操作不得从此入口执行。使用 ffa_sources 查看来源和参数。",
    outputSchema: Type.Object({ id: Type.String(), source: Type.String(), operation: Type.String(), parameters: params,
      binding: Type.String(), at: Type.String(), success: Type.Boolean(), data: Type.Unknown() }),
    parameters: Type.Object({ source: name, operation: name, parameters: params }),
    async execute(_id, args, signal) {
      access.check();
      const receipt = await service.read(args.source, args.operation, json(args.parameters) as Params, access.signal(signal));
      const text = JSON.stringify(receipt.data);
      return result({ ...receipt, data: text.length > 16000 ? { preview: text.slice(0, 16000), truncated: true, next: "ffa_record" } : receipt.data }, !receipt.success);
    },
  });
}

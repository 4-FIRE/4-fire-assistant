import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json, type Params } from "../common/json.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { name, params } from "./schemas/input.js";
import { result } from "./result.js";

export function providerCallTool(service: Pick<ExecutionService, "call">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_provider_call", label: "调用能力提供方",
    description: "按当前权限调用工具并保存真实回执。allow 直接调用；ask 请求本次批准；review 需先准备、独立复核，再执行；deny 禁止。权限不证明接口行为。",
    outputSchema: Type.Object({ id: Type.String(), provider: Type.String(), operation: Type.String(), parameters: params,
      binding: Type.String(), at: Type.String(), success: Type.Boolean(), data: Type.Unknown() }),
    parameters: Type.Object({ provider: name, operation: name, parameters: params }),
    async execute(_id, args, signal, _update, ctx) {
      access.check();
      const cancel = access.signal(signal);
      const receipt = await service.call(access.scope(ctx.sessionManager.getSessionId()), args.provider, args.operation, json(args.parameters) as Params,
        value => confirmations.ask(ctx, "批准本次工具调用", value, cancel), cancel);
      const text = JSON.stringify(receipt.data);
      return result({ ...receipt, data: text.length > 16000 ? { preview: text.slice(0, 16000), truncated: true, next: "ffa_record" } : receipt.data }, !receipt.success);
    },
  });
}

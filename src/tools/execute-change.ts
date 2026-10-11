import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExecutionService } from "../services/execution-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { intentOutput } from "./schemas/execution.js";
import { result } from "./result.js";

export function executeChangeTool(service: Pick<ExecutionService, "execute">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_execute_change", label: "确认并执行变更", executionMode: "sequential",
    description: "满足当前操作的复核要求后，请求用户确认实际影响和全部原生参数，最多发送一次。所有变更结果不明时禁止重发。",
    outputSchema: intentOutput, parameters: Type.Object({ intentId: name }),
    async execute(_id, args, signal, _update, ctx) {
      access.check(true); const cancel = access.signal(signal);
      const intent = await service.execute(args.intentId, access.scope(ctx.sessionManager.getSessionId()),
        value => confirmations.ask(ctx, "确认一次真实变更", value, cancel), cancel);
      return result({ ...intent });
    },
  });
}

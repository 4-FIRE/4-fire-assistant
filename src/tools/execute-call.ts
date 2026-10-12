import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExecutionService } from "../services/execution-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { intentOutput } from "./schemas/execution.js";
import { result } from "./result.js";

export function executeCallTool(service: Pick<ExecutionService, "execute">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_execute_call", label: "执行工具调用", executionMode: "sequential",
    description: "按当前工具权限检查准备与复核。ask 和 review 请求本次用户批准，allow 直接发送。不会重发已发送意图。",
    outputSchema: intentOutput, parameters: Type.Object({ intentId: name }),
    async execute(_id, args, signal, _update, ctx) {
      access.check(true); const cancel = access.signal(signal);
      const intent = await service.execute(args.intentId, access.scope(ctx.sessionManager.getSessionId()),
        value => confirmations.ask(ctx, "批准本次工具调用", value, cancel), cancel);
      return result({ ...intent });
    },
  });
}

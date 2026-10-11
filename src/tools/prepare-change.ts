import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json, type Params } from "../common/json.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { CallAccess } from "./access.js";
import { name, params } from "./schemas/input.js";
import { intentOutput } from "./schemas/execution.js";
import { result } from "./result.js";

export function prepareChangeTool(service: Pick<ExecutionService, "prepare">, access: CallAccess) {
  return defineTool({
    name: "ffa_prepare_change", label: "准备变更", executionMode: "sequential",
    description: "准备一次精确业务变更，不授权或发送。返回 execution；independent 要求独立复核，confirmation 仅需用户确认。参数变化须重新准备。",
    outputSchema: intentOutput,
    parameters: Type.Object({ objective: Type.String({ minLength: 1 }), source: name, operation: name, parameters: params }),
    async execute(_id, args, signal, _update, ctx) {
      access.check(true);
      const intent = await service.prepare(access.scope(ctx.sessionManager.getSessionId()), args.objective,
        args.source, args.operation, json(args.parameters) as Params, access.signal(signal));
      return result({ ...intent });
    },
  });
}

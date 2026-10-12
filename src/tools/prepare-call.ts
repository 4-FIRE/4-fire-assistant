import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json, type Params } from "../common/json.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { CallAccess } from "./access.js";
import { name, params } from "./schemas/input.js";
import { intentOutput } from "./schemas/execution.js";
import { result } from "./result.js";

export function prepareCallTool(service: Pick<ExecutionService, "prepare">, access: CallAccess) {
  return defineTool({
    name: "ffa_prepare_call", label: "准备工具调用", executionMode: "sequential",
    description: "准备一次精确工具调用，不发送。返回 permission；review 需独立复核和用户批准；ask 需用户批准；allow 不请求批准。参数或权限变化须重新准备。",
    outputSchema: intentOutput,
    parameters: Type.Object({ objective: Type.String({ minLength: 1 }), provider: name, operation: name, parameters: params }),
    async execute(_id, args, signal, _update, ctx) {
      access.check(true);
      const intent = await service.prepare(access.scope(ctx.sessionManager.getSessionId()), args.objective,
        args.provider, args.operation, json(args.parameters) as Params, access.signal(signal));
      return result({ ...intent });
    },
  });
}

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json, type Params } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import type { ExecutionService } from "../../services/execution/execution-service.js";
import type { Confirmations } from "../../ui/confirmation.js";
import type { CallAccess } from "../access.js";
import { name, params } from "../input.js";
import { result } from "../result.js";

const callInput = Type.Object({ provider: name, operation: name, parameters: params }, { additionalProperties: false });
const validCall = schema(callInput);
export function providerCallTool(service: Pick<ExecutionService, "call">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_provider_call", label: "调用能力提供方",
    description: "发送一次显式业务调用，必须提交 provider、原生 operation 和完整 parameters（无参数为 {}）。参数定义用 ffa_providers 查询；allow 直接发送，ask/review 请求本次批准，deny 拒绝。未知结果不等于未发送，不自动重发；用 ffa_provider_record 读取 intentId/receiptId 核对。success 不证明业务完成或成交。大结果只返回预览，完整正文按 dataPath 使用文件工具或计算读取。",
    outputSchema: Type.Object({ intentId: Type.String(), provider: Type.String(), operation: Type.String(), permission: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("review")]),
        state: Type.Union(["declined", "observed", "unknown"].map(value => Type.Literal(value))),
        receiptId: Type.Optional(Type.String()), outcome: Type.Optional(Type.Union(["accepted", "rejected", "unknown"].map(value => Type.Literal(value)))),
        success: Type.Boolean(), data: Type.Unknown(), dataPath: Type.Optional(Type.String()), truncated: Type.Optional(Type.Boolean()) }),
    parameters: callInput,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); requireThat(validCall(args), "调用只接受 provider、operation、parameters；读取记录使用 ffa_provider_record。");
      const cancel = access.signal(signal);
      const intent = await service.call(access.scope(ctx.sessionManager.getSessionId()), args.provider, args.operation, json(args.parameters) as Params,
        (value, recheck) => confirmations.ask(ctx, "批准本次工具调用", value, cancel, undefined, recheck), cancel);
      const data = intent.data ?? null, text = JSON.stringify(data), truncated = text.length > 16000;
      const success = intent.state === "observed" && intent.outcome === "accepted";
      return result({ intentId: intent.id, provider: intent.provider, operation: intent.operation, permission: intent.permission,
        state: intent.state, ...(intent.receiptId ? { receiptId: intent.receiptId } : {}),
        ...(intent.outcome ? { outcome: intent.outcome } : {}), success,
        ...(intent.dataPath ? { dataPath: intent.dataPath } : {}),
        data: truncated ? { preview: text.slice(0, 16000) } : data, ...(truncated ? { truncated: true } : {}) }, !success);
    },
  });
}

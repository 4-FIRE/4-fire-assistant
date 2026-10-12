import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { RecordService } from "../services/record-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { name, params } from "./schemas/input.js";
import { result } from "./result.js";

export function providerCallTool(service: Pick<ExecutionService, "call">, records: Pick<RecordService, "read">,
  access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_provider_call", label: "调用能力提供方",
    description: "调用或读取记录，两种输入互斥。调用使用 provider、operation、parameters：allow 直接发送；ask/review 请求本次用户批准；deny 拒绝。review 的方案独立复核由助手事先组织，程序不核验。返回 intentId、receiptId 和状态；未知结果不得自动重发。读取使用 record={kind,id,offset?,limit?}，不会发送。大结果用同一工具读取完整记录。",
    outputSchema: Type.Union([
      Type.Object({ intentId: Type.String(), provider: Type.String(), operation: Type.String(), permission: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("review")]),
        state: Type.Union(["declined", "observed", "unknown"].map(value => Type.Literal(value))),
        receiptId: Type.Optional(Type.String()), outcome: Type.Optional(Type.Union(["accepted", "rejected", "unknown"].map(value => Type.Literal(value)))),
        success: Type.Boolean(), data: Type.Unknown(), truncated: Type.Optional(Type.Boolean()) }),
      Type.Object({ text: Type.String(), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }),
    ]),
    parameters: Type.Union([
      Type.Object({ provider: name, operation: name, parameters: params }, { additionalProperties: false }),
      Type.Object({ record: Type.Object({ kind: Type.Union([Type.Literal("receipt"), Type.Literal("intent")]), id: name,
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) },
      { additionalProperties: false }) }, { additionalProperties: false }),
    ]),
    async execute(_id, args, signal, _update, ctx) {
      access.check();
      if ("record" in args) {
        const { kind, id, offset = 0, limit = 16000 } = args.record;
        const text = JSON.stringify(records.read(kind, id));
        requireThat(offset <= text.length, "分页位置超出记录。");
        return result({ text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null });
      }
      const cancel = access.signal(signal);
      const intent = await service.call(access.scope(ctx.sessionManager.getSessionId()), args.provider, args.operation, json(args.parameters) as Params,
        value => confirmations.ask(ctx, "批准本次工具调用", value, cancel), cancel);
      const data = intent.observation?.data ?? null, text = JSON.stringify(data), truncated = text.length > 16000;
      const success = intent.state === "observed" && intent.outcome === "accepted";
      return result({ intentId: intent.id, provider: intent.provider, operation: intent.operation, permission: intent.permission,
        state: intent.state, ...(intent.receiptId ? { receiptId: intent.receiptId } : {}),
        ...(intent.outcome ? { outcome: intent.outcome } : {}), success,
        data: truncated ? { preview: text.slice(0, 16000) } : data, ...(truncated ? { truncated: true } : {}) }, !success);
    },
  });
}

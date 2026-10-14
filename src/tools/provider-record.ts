import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { requireThat, schema } from "../common/validation.js";
import type { RecordService } from "../services/record-service.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

const input = Type.Object({ kind: Type.Union([Type.Literal("receipt"), Type.Literal("intent")]), id: name,
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) },
{ additionalProperties: false });
const valid = schema(input);
export function providerRecordTool(records: Pick<RecordService, "read">, access: CallAccess) {
  return defineTool({
    name: "ffa_provider_record", label: "读取调用记录",
    description: "分页读取执行意图或回执，不连接、不刷新、不批准、不发送。kind=intent/receipt，id 为调用返回的 intentId/receiptId。offset 默认 0，limit 默认 16000；索引按 JavaScript 字符串计数，nextOffset=null 表示结束。未知结果先核对记录与原生事实，不自动重发。",
    parameters: input,
    outputSchema: Type.Object({ text: Type.String(), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }),
    async execute(_id, args) {
      access.check(); requireThat(valid(args), "记录读取只接受 kind、id、offset、limit；分页范围无效或混入发送字段。");
      const { kind, id, offset = 0, limit = 16000 } = args;
      const text = JSON.stringify(records.read(kind, id));
      requireThat(offset <= text.length, "offset：分页位置超出记录。");
      return result({ text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null });
    },
  });
}

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { requireThat } from "../common/validation.js";
import type { RecordService } from "../services/record-service.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

export function recordTool(service: Pick<RecordService, "read">, access: CallAccess) {
  return defineTool({
    name: "ffa_record", label: "业务记录",
    description: "分页读取真实查询回执或执行意图。返回 JSON 文本片段，不修改记录。",
    outputSchema: Type.Object({ text: Type.String(), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }),
    parameters: Type.Object({ kind: Type.Union([Type.Literal("receipt"), Type.Literal("intent")]), id: name,
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }),
    async execute(_id, args) {
      access.check();
      const text = JSON.stringify(service.read(args.kind, args.id)), offset = args.offset ?? 0, limit = args.limit ?? 16000;
      requireThat(offset <= text.length, "分页位置超出记录。");
      return result({ text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null });
    },
  });
}

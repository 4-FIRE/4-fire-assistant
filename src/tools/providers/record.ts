import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { requireThat, schema } from "../../common/validation.js";
import type { RecordService } from "../../services/execution/record-service.js";
import type { CallAccess } from "../access.js";
import { name } from "../input.js";
import { result } from "../result.js";

const input = Type.Object({ kind: Type.Union([Type.Literal("receipt"), Type.Literal("intent")]), id: name }, { additionalProperties: false });
const valid = schema(input);
export function providerRecordTool(records: Pick<RecordService, "read">, access: CallAccess) {
  return defineTool({
    name: "ffa_provider_record", label: "读取调用记录",
    description: "读取调用或回执元数据，不连接、不批准、不发送。kind=intent/receipt，id 为 intentId/receiptId。归档回执按需恢复对应结果文件，dataPath 指向完整结果 JSON（data 和可选 raw 诊断）；旧路径不存在时先重新读取回执，再用 read 或计算读取，不重新执行原调用。未知结果先核对记录与原生事实，不自动重发。",
    parameters: input,
    outputSchema: Type.Object({ record: Type.Unknown() }),
    async execute(_id, args) {
      access.check(); requireThat(valid(args), "记录读取只接受 kind、id。");
      return result({ record: { ...records.read(args.kind, args.id) } });
    },
  });
}

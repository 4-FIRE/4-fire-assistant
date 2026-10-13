import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { WorkspaceUpdateService } from "../services/workspace-update-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { result } from "./result.js";

const file = Type.String({ minLength: 1 });
const change = Type.Object({ path: file, change: file });
const output = Type.Object({
  version: Type.Integer(), target: Type.Integer(), done: Type.Boolean(),
  batch: Type.Optional(Type.String()), from: Type.Optional(Type.Integer()), to: Type.Optional(Type.Integer()),
  stage: Type.Optional(Type.Union([Type.Literal("planning"), Type.Literal("program"), Type.Literal("documents")])),
  summary: Type.Optional(Type.String()), instructions: Type.Optional(Type.String()),
  requiredDocuments: Type.Optional(Type.Array(file)), plans: Type.Optional(Type.Array(Type.Array(change))),
  chain: Type.Optional(Type.Array(Type.Object({ from: Type.Integer(), to: Type.Integer(), summary: Type.String(),
    instructions: Type.String(), requiredDocuments: Type.Array(file) }))),
  next: Type.Optional(Type.String()),
});
export function workspaceUpdateTools(service: WorkspaceUpdateService, access: CallAccess, confirmations: Confirmations) {
  return [defineTool({
    name: "ffa_update_workspace", label: "准备工作区升级", executionMode: "sequential",
    description: "仅在 /ffa update 后接续当前升级。提交文件修改方案，经确认和备份后执行包内程序阶段。改变方案须再次确认。",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("resume") }),
      Type.Object({ action: Type.Literal("plan"), batch: file, from: Type.Integer({ minimum: 1 }), documents: Type.Array(change),
        following: Type.Optional(Type.Array(Type.Object({ from: Type.Integer({ minimum: 1 }), documents: Type.Array(change) }))) }),
    ]), outputSchema: output,
    async execute(_id, args, signal, _update, ctx) {
      access.check(true); const cancel = access.signal(signal);
      return result(args.action === "resume" ? await service.resume(cancel) :
        await service.plan(args.batch, args.from, args.documents,
          (value, approvalSignal) => confirmations.ask(ctx, "确认工作区升级方案", value, approvalSignal), cancel, args.following));
    },
  }), defineTool({
    name: "ffa_finish_update", label: "完成当前版本升级", executionMode: "sequential",
    description: "提交已修改、无需修改和未解决项。检查程序阶段与资料条件，经用户确认后记录目标版本；不授予交易许可。",
    parameters: Type.Object({ batch: file, from: Type.Integer({ minimum: 1 }),
      modified: Type.Array(file), unchanged: Type.Array(file), unresolved: Type.Array(file) }), outputSchema: output,
    async execute(_id, args, signal, _update, ctx) {
      access.check(true); const cancel = access.signal(signal);
      const value = await service.complete(args.batch, args.from, args,
        (data, approvalSignal) => confirmations.ask(ctx, "确认该版工作区升级完成（不授权交易）", data, approvalSignal), cancel);
      return result({ ...value, next: value.done ? "执行 Pi 原生 /reload；不自动开展业务。" : "调用 ffa_update_workspace 的 resume 操作准备下一版。" });
    },
  })];
}

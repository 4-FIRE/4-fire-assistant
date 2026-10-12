import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ExpertRef } from "../model/expert.js";
import type { ExpertService, ExpertRun } from "../services/expert-service.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

export type BindExpertRun = (ctx: ExtensionToolContext, signal: AbortSignal, progress: (value: unknown) => void) => ExpertRun;

export function delegateTool(service: Pick<ExpertService, "delegate">, access: CallAccess, bindRun: BindExpertRun) {
  return defineTool({
    name: "ffa_delegate", label: "委派独立专家",
    description: "按需创建独立专家。expertId 可追问当前分支的专家。复核必须指定当前 intentId，批准不等于用户授权。",
    outputSchema: Type.Object({ expert: Type.Object({ id: Type.String(), role: Type.Union([Type.Literal("researcher"), Type.Literal("reviewer")]), file: Type.String() }),
      report: Type.String(), failed: Type.Boolean() }),
    parameters: Type.Object({ role: Type.Union([Type.Literal("researcher"), Type.Literal("reviewer")]),
      goal: Type.String({ minLength: 1, maxLength: 24000 }), expertId: Type.Optional(name), intentId: Type.Optional(name) }),
    async execute(_id, args, signal, onUpdate, ctx) {
      access.check(true); const cancel = access.signal(signal);
      const refs = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ffa.expert")
        .map(entry => new ExpertRef((entry as { data: ExpertRef }).data));
      const progress = (value: unknown) => onUpdate?.(result(value));
      const run = bindRun(ctx, cancel, progress);
      const answer = await service.delegate(args, refs, access.scope(ctx.sessionManager.getSessionId()),
        task => { progress({ status: "running", role: args.role }); return run(task); }, cancel);
      return { ...result({ expert: { ...answer.expert }, report: answer.report, failed: answer.failed }, answer.failed), usage: answer.usage };
    },
  });
}

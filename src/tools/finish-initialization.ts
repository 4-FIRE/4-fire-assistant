import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InitializationService } from "../services/initialization-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

export function finishInitializationTool(service: Pick<InitializationService, "complete">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_finish_initialization", label: "完成投资工作区初始化", executionMode: "sequential",
    description: "提交真实行情和历史 K 线回执 ID。检查完整能力分析、资料、当前来源及用户确认后完成初始化。不会执行交易。",
    outputSchema: Type.Object({ ready: Type.Literal(true), next: Type.String() }),
    parameters: Type.Object({ market: Type.String({ minLength: 1 }), quote: name, history: name }),
    async execute(_id, args, signal, _update, ctx) {
      access.check(); const cancel = access.signal(signal);
      await service.complete(args, value => confirmations.ask(ctx, "确认启用投资工作区", value, cancel), cancel);
      return result({ ready: true, next: "执行 Pi 原生 /reload 加载投资角色、技能和业务工具；下次启动自动启用。" });
    },
  });
}

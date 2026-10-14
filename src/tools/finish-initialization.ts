import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InitializationService } from "../services/initialization-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { result } from "./result.js";

export function finishInitializationTool(service: Pick<InitializationService, "complete">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_finish_initialization", label: "完成工作区初始化", executionMode: "sequential",
    description: "检查根资料入口与内部权限配置，展示已注册能力并经用户确认后完成初始化。工具提供、目录发现、连接验证和手册补齐不阻塞启用；目标市场可选。",
    outputSchema: Type.Object({ ready: Type.Literal(true), next: Type.String() }),
    parameters: Type.Object({ market: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }),
    async execute(_id, args, signal, _update, ctx) {
      access.check(); const cancel = access.signal(signal);
      await service.complete(args, value => confirmations.ask(ctx, "确认启用工作区", value, cancel), cancel);
      return result({ ready: true, next: "执行 Pi 原生 /reload 加载角色、技能和工作区工具；下次启动自动启用。" });
    },
  });
}

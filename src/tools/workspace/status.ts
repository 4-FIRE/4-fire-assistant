import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { workspaceFormat } from "../../common/version.js";
import type { InitializationService } from "../../services/workspace/initialization-service.js";
import type { ExecutionService } from "../../services/execution/execution-service.js";
import type { ProviderRegistry } from "../../services/providers/provider-registry.js";
import type { CallAccess } from "../access.js";
import { intentOutput } from "./status-schema.js";
import { result } from "../result.js";

export function statusTool(workspace: Pick<InitializationService, "snapshot">, execution: Pick<ExecutionService, "unknownCalls">,
  providers: Pick<ProviderRegistry, "notices">, access: CallAccess) {
  return defineTool({
    name: "ffa_status", label: "工作区状态", description: "查看工作区状态和调用时结果不明的历史记录。不表示当前订单状态，不执行或重发。",
    outputSchema: Type.Object({ workspace: Type.Object({ format: Type.Literal(workspaceFormat), status: Type.Literal("ready"), market: Type.Optional(Type.String()) }),
      unknownCalls: Type.Array(intentOutput), notices: Type.Array(Type.String()) }),
    parameters: Type.Object({}),
    async execute() {
      access.check(true);
      return result({ workspace: { ...workspace.snapshot() }, unknownCalls: execution.unknownCalls().map(intent => ({ ...intent })), notices: providers.notices });
    },
  });
}

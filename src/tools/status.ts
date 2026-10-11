import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InitializationService } from "../services/initialization-service.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { SourceService } from "../services/source-service.js";
import type { CallAccess } from "./access.js";
import { intentOutput } from "./schemas/execution.js";
import { result } from "./result.js";

export function statusTool(workspace: Pick<InitializationService, "snapshot">, execution: Pick<ExecutionService, "unsettled">,
  sources: Pick<SourceService, "notices">, access: CallAccess) {
  return defineTool({
    name: "ffa_status", label: "投资工作区状态", description: "查看初始化状态和本工作区待核对变更。不会执行或重发。",
    outputSchema: Type.Object({ workspace: Type.Object({ format: Type.Literal("ffa-pi/2"), status: Type.Literal("ready"), market: Type.String() }),
      unresolved: Type.Array(intentOutput), notices: Type.Array(Type.String()) }),
    parameters: Type.Object({}),
    async execute() {
      access.check(true);
      return result({ workspace: { ...workspace.snapshot() }, unresolved: execution.unsettled().map(intent => ({ ...intent })), notices: sources.notices });
    },
  });
}

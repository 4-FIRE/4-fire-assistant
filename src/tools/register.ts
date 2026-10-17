import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import type { ProviderRegistry } from "../services/providers/provider-registry.js";
import type { ExecutionService } from "../services/execution/execution-service.js";
import type { InitializationService } from "../services/workspace/initialization-service.js";
import type { RecordService } from "../services/execution/record-service.js";
import type { AgentService } from "../services/agents/agent-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { providersTool } from "./providers/catalog.js";
import { providerCallTool } from "./providers/call.js";
import { providerManageTool } from "./providers/manage.js";
import { providerRecordTool } from "./providers/record.js";
import { finishInitializationTool } from "./workspace/finish-initialization.js";
import { statusTool } from "./workspace/status.js";
import { agentTool, type BindAgentRun } from "./agents/tool.js";

export interface ToolServices {
  providers: ProviderRegistry; execution: ExecutionService; initialization: InitializationService;
  records: RecordService; agents: AgentService;
}
export function mainTools(services: ToolServices, access: CallAccess, confirmations: Confirmations, run: BindAgentRun): ToolDefinition[] {
  const { providers, execution, initialization, records, agents } = services;
  const tools: ToolDefinition[] = [providersTool(providers, access), providerCallTool(execution, access, confirmations),
    providerManageTool(providers, access, confirmations), providerRecordTool(records, access)];
  if (initialization.snapshot().status === "pending") {
    tools.push(finishInitializationTool(initialization, access, confirmations));
  } else {
    tools.push(statusTool(initialization, execution, providers, access),
      agentTool(agents, access, run));
  }
  return tools;
}
export class ToolRegistry {
  readonly #registered = new Map<string, ToolDefinition>();
  constructor(private readonly pi: ExtensionAPI) {}
  register(tools: ToolDefinition[]) {
    const promptGuidelines = readFileSync(join(resourceRoot, "prompts/tool-guidelines.md"), "utf8")
      .trim().split(/\r?\n\s*\r?\n/);
    for (const definition of tools) {
      const tool = { ...definition, namespace: { name: "ffa", description: "工作区协作：学习与知识积累、任务与项目推进、研究与决策支持；提供能力接入、专家协作与受控调用。" },
        promptGuidelines };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}

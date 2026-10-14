import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { InitializationService } from "../services/initialization-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { RecordService } from "../services/record-service.js";
import type { AgentService } from "../services/agent-service.js";
import type { WorkspaceUpdateService } from "../services/workspace-update-service.js";
import { workspaceUpdateTools } from "./workspace-update.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { providersTool } from "./providers.js";
import { providerCallTool } from "./provider-call.js";
import { providerManageTool } from "./provider-manage.js";
import { providerRecordTool } from "./provider-record.js";
import { finishInitializationTool } from "./finish-initialization.js";
import { pythonTool } from "./python.js";
import { statusTool } from "./status.js";
import { agentTool, type BindAgentRun } from "./agent.js";

export interface ToolServices {
  providers: ProviderRegistry; execution: ExecutionService; initialization: InitializationService;
  research: ResearchService; records: RecordService; agents: AgentService; updates: WorkspaceUpdateService;
}
export function mainTools(services: ToolServices, access: CallAccess, confirmations: Confirmations, run: BindAgentRun): ToolDefinition[] {
  const { providers, execution, initialization, research, records, agents } = services;
  const tools: ToolDefinition[] = [providersTool(providers, access), providerCallTool(execution, access, confirmations),
    providerManageTool(providers, access, confirmations), providerRecordTool(records, access)];
  if (initialization.snapshot().status === "pending") {
    tools.push(finishInitializationTool(initialization, access, confirmations));
  } else {
    tools.push(pythonTool(research, access), statusTool(initialization, execution, providers, access),
      agentTool(agents, access, run), ...workspaceUpdateTools(services.updates, access, confirmations));
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
      const tool = { ...definition, namespace: { name: "ffa", description: "工作区协作：学习与知识积累、任务与项目推进、研究与决策支持；提供能力接入、计算、专家协作与受控调用。" },
        promptGuidelines };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}

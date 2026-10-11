import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import type { SourceService } from "../services/source-service.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { InitializationService } from "../services/initialization-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { RecordService } from "../services/record-service.js";
import type { ExpertService } from "../services/expert-service.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { sourcesTool } from "./sources.js";
import { sourceReadTool } from "./source-read.js";
import { recordTool } from "./record.js";
import { configureSourceTool } from "./configure-source.js";
import { discoverSourceTool } from "./discover-source.js";
import { finishInitializationTool } from "./finish-initialization.js";
import { pythonTool } from "./python.js";
import { statusTool } from "./status.js";
import { prepareChangeTool } from "./prepare-change.js";
import { executeChangeTool } from "./execute-change.js";
import { delegateTool, type BindExpertRun } from "./delegate.js";

export interface ToolServices {
  sources: SourceService; execution: ExecutionService; initialization: InitializationService;
  research: ResearchService; records: RecordService; experts: ExpertService;
}
export function mainTools(services: ToolServices, access: CallAccess, confirmations: Confirmations, run: BindExpertRun): ToolDefinition[] {
  const { sources, execution, initialization, research, records, experts } = services;
  const tools: ToolDefinition[] = [sourcesTool(sources, access), sourceReadTool(sources, access),
    recordTool(records, access), configureSourceTool(sources, access, confirmations), discoverSourceTool(sources, access)];
  if (initialization.snapshot().status === "pending") {
    tools.push(finishInitializationTool(initialization, access, confirmations));
  } else {
    tools.push(pythonTool(research, access), statusTool(initialization, execution, sources, access),
      prepareChangeTool(execution, access), executeChangeTool(execution, access, confirmations), delegateTool(experts, access, run));
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
      const tool = { ...definition, namespace: { name: "ffa", description: "投资工作区：来源、研究、专家与受控变更。" },
        promptGuidelines };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}

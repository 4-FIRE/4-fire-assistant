import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
    for (const definition of tools) {
      const tool = { ...definition, namespace: { name: "ffa", description: "投资工作区：来源、研究、专家与受控变更。" },
        promptGuidelines: ["FFA 工具返回结构化对象；检查 success、state 或 failed 判断业务结果。",
          "有依赖的 FFA 调用按顺序 await；确认与专家任务可能需要较长等待。取消或脚本失败不回滚已发生的副作用。"] };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}

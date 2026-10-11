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
        promptGuidelines: ["FFA 工具支持直接调用和 codemode，返回结构化对象。",
          "配置、初始化、委派和变更按业务顺序 await，不并发推进。确认与专家任务需留出等待时间。",
          "脚本失败不撤销已完成操作。变更不得自动重试；先查询账本核对。"] };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}

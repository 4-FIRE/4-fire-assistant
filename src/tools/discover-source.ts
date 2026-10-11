import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SourceService } from "../services/source-service.js";
import type { CallAccess } from "./access.js";
import { catalogOutput } from "./schemas/source.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

export function discoverSourceTool(service: Pick<SourceService, "discover">, access: CallAccess) {
  return defineTool({
    name: "ffa_discover_source", label: "发现完整来源能力", executionMode: "sequential",
    description: "读取已确认 MCP 连接的全部工具分页，不调用业务操作。新增或变化的工具先标记待分析，不自动授权。发现失败保留旧目录并禁止调用。CLI 请依据完整服务文档配置目录及覆盖缺口。",
    parameters: Type.Object({ source: name }), outputSchema: catalogOutput,
    async execute(_id, args, signal) {
      access.check();
      const catalog = await service.discover(args.source, access.signal(signal));
      return result({ ...catalog, operations: catalog.operations.map(op => ({ ...op })) });
    },
  });
}

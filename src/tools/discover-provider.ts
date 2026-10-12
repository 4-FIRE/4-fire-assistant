import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { CallAccess } from "./access.js";
import { catalogOutput } from "./schemas/provider.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

export function discoverProviderTool(service: Pick<ProviderRegistry, "discover">, access: CallAccess) {
  return defineTool({
    name: "ffa_discover_provider", label: "发现完整能力提供方能力", executionMode: "sequential",
    description: "读取已确认 MCP 连接的全部工具分页，不调用业务操作。发现不修改权限配置；未配置工具使用默认权限。发现失败保留旧目录并禁止调用。CLI 请依据完整能力提供方文档配置目录及覆盖缺口。",
    parameters: Type.Object({ provider: name }), outputSchema: catalogOutput,
    async execute(_id, args, signal) {
      access.check();
      const catalog = await service.discover(args.provider, access.signal(signal));
      return result(catalog);
    },
  });
}

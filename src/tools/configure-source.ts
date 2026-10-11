import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { object } from "../common/json.js";
import type { SourceService } from "../services/source-service.js";
import { sourceData } from "../services/source-config.js";
import { sourceSummary } from "../ui/source-display.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { result } from "./result.js";

export function configureSourceTool(service: Pick<SourceService, "configure">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_configure_source", label: "配置投资来源", executionMode: "sequential",
    description: "经用户确认连接和完整能力分析，不授予单次变更许可。先读接入技能及 references/connections.md。新 MCP 连接用空 operations，随后发现全部工具再分析。CLI 提供完整已知目录及覆盖缺口。不能按当前任务挑选接口。凭据仅用 ${ENV_NAME} 引用。",
    outputSchema: Type.Object({ configured: Type.String(), next: Type.String() }),
    parameters: Type.Object({ source: Type.Unknown() }),
    renderCall(args) {
      const source = object(args.source) ? args.source : {};
      return new Text(`配置来源：${JSON.stringify(source.id ?? "")} · ${JSON.stringify(source.kind ?? "")}\n接口与权限见确认窗口。`, 0, 0);
    },
    async execute(_id, args, signal, _update, ctx) {
      access.check(); const cancel = access.signal(signal);
      const configured = await service.configure(args.source, source =>
        confirmations.ask(ctx, "确认来源连接与完整调用约定（不是变更授权）", sourceData(source), cancel, sourceSummary(source)), cancel);
      return result({ configured, next: "MCP 先调用 ffa_discover_source 并逐项分析。核实真实观察调用，维护 sources/" + configured + "/GUIDE.md。" });
    },
  });
}

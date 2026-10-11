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
    description: "经用户确认来源连接与完整调用约定，不授予业务变更许可。配置契约见 FFA 包内资料根目录下 references/connections.md。凭据仅用 ${ENV_NAME} 引用。",
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
      return result({ configured, next: "用 ffa_sources 查看当前目录；MCP 尚未发现或目录失效时用 ffa_discover_source。服务资料保存在 sources/" + configured + "/GUIDE.md。" });
    },
  });
}

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { object } from "../common/json.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import { providerData } from "../services/provider-config.js";
import { permissionSchema, catalogOutput } from "./schemas/provider.js";
import type { Permission } from "../model/permission.js";
import { providerSummary } from "../ui/provider-display.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { result } from "./result.js";

export function configureProviderTool(service: Pick<ProviderRegistry, "configure">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_configure_provider", label: "配置能力提供方", executionMode: "sequential",
    description: "确认能力提供方配置。provider 为完整配置时，保存后自动发现 MCP 目录；发现失败保留注册并报告状态。provider 为 ID 时，仅确认初始 permissions，不重交目录或重连。权限只添加缺失规则，保留用户设置；默认 ask。契约见 references/providers.md，凭据仅引用 ${ENV_NAME}。",
    outputSchema: Type.Object({ configured: Type.String(), providers: Type.Array(catalogOutput), discoveryError: Type.Optional(Type.String()) }),
    parameters: Type.Object({ provider: Type.Unknown(), permissions: Type.Optional(Type.Record(Type.String(), permissionSchema)) }, { additionalProperties: false }),
    renderCall(args) {
      const provider = object(args.provider) ? args.provider : { id: args.provider };
      return new Text(`配置能力提供方：${JSON.stringify(provider.id ?? "")} · ${JSON.stringify(provider.kind ?? "")}\n接口与权限见确认窗口。`, 0, 0);
    },
    async execute(_id, args, signal, _update, ctx) {
      access.check(); const cancel = access.signal(signal);
      const configured = await service.configure(args.provider, (provider, permissions) =>
        confirmations.ask(ctx, typeof args.provider === "string" ? "确认初始工具权限" : "确认能力提供方连接与初始工具权限",
            { provider: providerData(provider), permissions }, cancel,
          providerSummary(provider, permissions)), cancel, args.permissions as Record<string, Permission> | undefined);
      return result(configured, !!configured.discoveryError);
    },
  });
}

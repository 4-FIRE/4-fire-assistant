import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { object } from "../common/json.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import { providerData } from "../services/provider-config.js";
import { permissionSchema } from "./schemas/provider.js";
import type { Permission } from "../model/permission.js";
import { providerSummary } from "../ui/provider-display.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { CallAccess } from "./access.js";
import { result } from "./result.js";

export function configureProviderTool(service: Pick<ProviderRegistry, "configure">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_configure_provider", label: "配置能力提供方", executionMode: "sequential",
    description: "确认能力提供方连接、完整目录和初始工具权限。模型通过 permissions 提交建议，以工具唯一 ID 为 key；程序校验、请求确认并保存，只添加缺失规则，保留用户设置。默认 ask，资料不明确也用 ask。契约见 references/providers.md，凭据仅引用 ${ENV_NAME}。",
    outputSchema: Type.Object({ configured: Type.String(), next: Type.String() }),
    parameters: Type.Object({ provider: Type.Unknown(), permissions: Type.Optional(Type.Record(Type.String(), permissionSchema)) }),
    renderCall(args) {
      const provider = object(args.provider) ? args.provider : {};
      return new Text(`配置能力提供方：${JSON.stringify(provider.id ?? "")} · ${JSON.stringify(provider.kind ?? "")}\n接口与权限见确认窗口。`, 0, 0);
    },
    async execute(_id, args, signal, _update, ctx) {
      access.check(); const cancel = access.signal(signal);
      const configured = await service.configure(args.provider, (provider, permissions) =>
        confirmations.ask(ctx, "确认能力提供方连接与初始工具权限", { provider: providerData(provider), permissions }, cancel,
          providerSummary(provider, permissions)), cancel, args.permissions as Record<string, Permission> | undefined);
      return result({ configured, next: "用 ffa_providers 查看当前目录；MCP 尚未发现或目录失效时用 ffa_discover_provider。能力提供方资料保存在 providers/" + configured + "/GUIDE.md。" });
    },
  });
}

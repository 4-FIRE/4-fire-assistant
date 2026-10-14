import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { providerSummary } from "../ui/provider-display.js";
import { toolId } from "../common/tool-id.js";
import { Text } from "@earendil-works/pi-tui";
import { object } from "../common/json.js";
import { schema } from "../common/validation.js";
import type { ManagementRequest } from "../model/provider-management.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import { ProviderEditError } from "../services/provider-edits.js";
import type { CallAccess } from "./access.js";
import type { Confirmations } from "../ui/confirmation.js";
import { managementInput, managementOutput, managementBranches, connectionSchema } from "./schemas/provider-management.js";
import { result } from "./result.js";

const valid = schema(managementInput);
export function validateManagement(value: unknown): asserts value is ManagementRequest {
  const matches: boolean = valid(value);
  if (matches) return;
  if (!object(value)) throw new Error("input：需要管理请求对象。");
  const candidates = managementBranches.filter(branch => {
    const properties = branch.properties as Record<string, { const?: unknown; properties?: Record<string, { const?: unknown }> }>;
    return ["action", "target", "mode"].every(key => !(key in properties) || properties[key]!.const === value[key]) &&
      (!object(value.config) || !properties.config?.properties ||
        properties.config.properties.kind?.const === value.config.kind);
  });
  for (const branch of candidates) {
    const check = schema(branch);
    const matches: boolean = check(value);
    if (matches) return;
    const error = check.errors?.find(error => error.keyword === "additionalProperties" || error.keyword === "required") ?? check.errors?.[0];
    if (error && error.instancePath !== "/config") {
      const field = error.params.additionalProperty ?? error.params.missingProperty ?? "";
      const path = [error.instancePath.replace(/^\//, "").replaceAll("/", "."), field].filter(Boolean).join(".") || "input";
      throw new Error(`${path}：${error.keyword === "additionalProperties" ? "此分支不接受该字段" : error.keyword === "required" ? "缺少必要字段" : "字段不符合当前分支契约"}；请按 action/target 的定义提交。`);
    }
  }
  const config = value.config;
  if (object(config)) {
    const branch = connectionSchema.anyOf.find(branch => branch.properties.kind.const === config.kind &&
      ("url" in branch.properties ? "url" in config : "command" in config));
    if (branch) {
      const check = schema(branch); check(value.config);
      const error = check.errors?.[0];
      if (error) throw new Error(`config${error.instancePath.replaceAll("/", ".")}.${error.params.additionalProperty ?? error.params.missingProperty ?? ""}：连接字段不符合所选类型；CLI 不接受 MCP 发现状态或原生定义。`);
    }
  }
  throw new Error("action/target/config：无匹配的管理输入分支；请查看工具签名，不要回传内部目录。");
}
export function providerManageTool(service: Pick<ProviderRegistry, "manage">, access: CallAccess, confirmations: Confirmations) {
  return defineTool({
    name: "ffa_provider_manage", label: "管理能力提供方", executionMode: "sequential",
    description: "管理接入与权限。read 按 target 取得可编辑数据和 revision；register 只创建，CLI 可附完整目录和初始权限，MCP 只提交连接并自动发现；update 按 target 修改，已有对象须 expectedRevision；discover 只刷新已注册 MCP。target 为 connection/operations/coverage/outcomes/permissions。CLI operations 用 add/replace，不回传无关接口。权限以原生操作名为键：suggest 只补缺失，set 可修改，null 恢复继承。所有变更需用户确认，发现不调用业务操作。读取不连接；业务调用定义用 ffa_providers，发送用 ffa_provider_call。检查各阶段结果，部分失败不要重复注册。",
    parameters: Type.Unsafe<ManagementRequest>(managementInput), outputSchema: managementOutput,
    renderCall(args) { return new Text(`管理能力提供方：${args.provider} · ${args.action}${"target" in args ? " / " + args.target : ""}`, 0, 0); },
    async execute(_id, args, signal, _update, ctx) {
      access.check(); validateManagement(args);
      try {
        const data = await service.manage(args, (value, recheck, cancel) => {
          const { provider, permissions, clearedOutcomes } = value;
          const changes = Object.entries(permissions.applied).map(([name, permission]) => {
            const id = toolId(provider.id, name), old = permissions.before.tools[id];
            return `${name}：${old ?? "继承 " + permissions.before.default} → ${permission ?? "继承 " + permissions.after.default}`;
          });
          const summary = [providerSummary(provider, permissions.after), ...changes,
            ...(clearedOutcomes.length ? ["将清除结果契约：" + clearedOutcomes.join("、")] : [])].join("\n");
          return confirmations.ask(ctx, "确认能力提供方变更", value, cancel, summary, recheck);
        }, access.signal(signal));
        return result(data, "error" in data && !!data.error);
      } catch (error) {
        if (error instanceof ProviderEditError) return result({ provider: args.provider, action: args.action, error: error.failure }, true);
        throw error;
      }
    },
  });
}

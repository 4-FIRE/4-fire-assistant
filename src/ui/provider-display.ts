import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Operation, Provider } from "../model/provider.js";
import { object } from "../common/json.js";
import { toolId } from "../common/tool-id.js";
import type { Permission, Permissions } from "../model/permission.js";

// Descriptions and names can come from a provider. Do not interpret terminal controls.
function plain(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, char => JSON.stringify(char).slice(1, -1));
}
function parameterType(value: unknown): string {
  if (!object(value)) return "unknown";
  if ("const" in value) return JSON.stringify(value.const);
  if (Array.isArray(value.enum)) return value.enum.map(item => JSON.stringify(item)).join(" | ");
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(value[key])) return value[key].map(parameterType).join(" | ");
  }
  if (Array.isArray(value.type)) return value.type.map(type => parameterType({ ...value, type })).join(" | ");
  if (value.type === "array") return `Array<${parameterType(value.items)}>`;
  if (value.type === "integer") return "number";
  if (["string", "number", "boolean", "object", "null"].includes(String(value.type))) return String(value.type);
  return object(value.properties) ? "object" : "unknown";
}
export function operationSignature(operation: Pick<Operation, "name" | "inputSchema">): string {
  const schema = operation.inputSchema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = object(schema.properties) ? schema.properties : {};
  const args = Object.entries(properties).map(([key, value]) => {
    const name = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    return `${name}${required.includes(key) ? "" : "?"}: ${parameterType(value)}`;
  });
  if (schema.additionalProperties !== false) args.push("...extra: unknown");
  return `${plain(operation.name)}(${args.join(", ")})`;
}
export function operationSummary(operation: Operation & { permission?: Permission; id?: string }): string {
  // The complete provider documentation remains in the structured result and raw view.
  const firstLine = operation.description.split(/\r\n|[\r\n]|\\r\\n|\\[rn]/).find(line => line.trim()) ?? "";
  const description = truncateToWidth(plain(firstLine.trim().replace(/\s+/gu, " ")), 80);
  const labels = { allow: "完全访问", ask: "请求批准", review: "独立复核", deny: "禁止使用" };
  const state = operation.available === false ? "不可用" : labels[operation.permission ?? "ask"];
  return `[${state}] ${operationSignature(operation)}${operation.id ? "\n  ID：" + plain(operation.id) : ""}\n  ${description}`;
}
export function providerSummary(provider: Provider, permissions: Permissions): string {
  const connection = provider.url ? `连接：${plain(provider.url)}` : `命令：${JSON.stringify(provider.command)}\n启动参数：${JSON.stringify(provider.args ?? [])}`;
  const references = Object.entries({ env: provider.env, headers: provider.headers })
    .filter(([, value]) => value !== undefined).map(([key, value]) => `${key} 引用：${JSON.stringify(value)}`);
  return [`能力提供方：${plain(provider.id)} · ${provider.kind.toUpperCase()}`, connection, ...references,
    `目录：共 ${provider.operations.length} 项；默认权限 ${permissions.default}`,
    ...(provider.discovery ? [`发现：${plain(provider.discovery.status)} · ${plain(provider.discovery.scope)}`] : provider.kind === "mcp" ? ["尚未发现目录；本次仅确认连接，发现后按权限调用。"] : []),
    ...(provider.coverage ? [`资料依据：${plain(provider.coverage.basis)}\n覆盖缺口：${provider.coverage.limitations.map(plain).join("；")}`] : []),
    "签名仅作摘要；参数限制、CLI 绑定和回执规则见完整配置。", "",
    provider.operations.map(op => {
      const id = toolId(provider.id, op.name);
      return operationSummary({ ...op, id, permission: Object.hasOwn(permissions.tools, id) ? permissions.tools[id]! : permissions.default });
    }).join("\n\n")].join("\n");
}

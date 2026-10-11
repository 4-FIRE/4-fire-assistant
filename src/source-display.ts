import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Operation, Source } from "./sources.js";
import { object } from "./values.js";

// Descriptions and names can come from a service. Do not interpret terminal controls.
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
export function operationSummary(operation: Operation): string {
  // The complete service documentation remains in the structured result and raw view.
  const firstLine = operation.description.split(/\r\n|[\r\n]|\\r\\n|\\[rn]/).find(line => line.trim()) ?? "";
  const description = truncateToWidth(plain(firstLine.trim().replace(/\s+/gu, " ")), 80);
  return `[${operation.access === "write" ? "写入" : "只读"}] ${operationSignature(operation)}\n  ${description}`;
}
export function sourceSummary(source: Source): string {
  const connection = source.url ? `连接：${plain(source.url)}` : `命令：${JSON.stringify(source.command)}\n启动参数：${JSON.stringify(source.args ?? [])}`;
  const references = Object.entries({ env: source.env, headers: source.headers })
    .filter(([, value]) => value !== undefined).map(([key, value]) => `${key} 引用：${JSON.stringify(value)}`);
  return [`来源：${plain(source.id)} · ${source.kind.toUpperCase()}`, connection, ...references,
    `操作：只读 ${source.operations.filter(op => op.access === "read").length}，写入 ${source.operations.filter(op => op.access === "write").length}`,
    "签名仅作摘要；参数限制、CLI 绑定和回执规则见完整配置。", "",
    source.operations.map(operationSummary).join("\n\n")].join("\n");
}

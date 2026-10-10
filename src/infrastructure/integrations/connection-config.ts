import { isAbsolute } from "node:path";
import { AssistantError } from "../../application/ports.js";
import { object } from "../../domain/shared.js";

export type ConnectionConfig =
  | { transport: "http"; url: string; apiKeyEnv?: string; apiKeyHeader?: "X-API-Key" | "Authorization"; timeoutMs?: number }
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number };
export interface CliConnectionConfig {
  command: string;
  /** Environment references, not credential values. */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export type SourceConnection = ConnectionConfig | ({ transport: "cli" } & CliConnectionConfig);

function invalid(): never { throw new AssistantError("INVALID_CONFIG", "连接配置无效；原配置未修改，敏感内容不会显示。"); }
function environment(value: unknown): void {
  if (value !== undefined && (!object(value) || Object.entries(value).some(([key, ref]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)))) invalid();
}
function positiveInteger(value: unknown, max: number): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max)) invalid();
}
export function parseCliConnection(value: unknown): CliConnectionConfig {
  if (!object(value) || typeof value.command !== "string" || !isAbsolute(value.command) ||
      Object.keys(value).some(key => !["command", "env", "timeoutMs", "maxOutputBytes"].includes(key))) invalid();
  environment(value.env);
  positiveInteger(value.timeoutMs, 120000);
  positiveInteger(value.maxOutputBytes, 16 * 1024 * 1024);
  return structuredClone(value) as unknown as CliConnectionConfig;
}
export function parseSourceConnection(value: unknown): SourceConnection {
  if (!object(value)) invalid();
  if (value.transport === "cli") {
    const { transport: _transport, ...settings } = value;
    return { transport: "cli", ...parseCliConnection(settings) };
  }
  if (typeof value.transport !== "string" || !["http", "stdio"].includes(value.transport)) invalid();
  positiveInteger(value.timeoutMs, 120000);
  if (value.transport === "http") {
    if (Object.keys(value).some(k => !["transport", "url", "apiKeyEnv", "apiKeyHeader", "timeoutMs"].includes(k)) || typeof value.url !== "string") invalid();
    try { const url = new URL(value.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid(); } catch { invalid(); }
    if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))) invalid();
    if (value.apiKeyHeader !== undefined && (typeof value.apiKeyHeader !== "string" || !["X-API-Key", "Authorization"].includes(value.apiKeyHeader))) invalid();
  } else {
    if (Object.keys(value).some(k => !["transport", "command", "args", "env", "timeoutMs"].includes(k)) || typeof value.command !== "string" || !value.command.trim()) invalid();
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(arg => typeof arg === "string" && !arg.includes("\0")))) invalid();
    environment(value.env);
  }
  return structuredClone(value) as unknown as ConnectionConfig;
}

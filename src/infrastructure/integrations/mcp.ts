import { randomUUID, createHash } from "node:crypto";
import { McpClient, StdioTransport, StreamableHttpTransport, type Tool, type CallToolResult, type McpTransport } from "@earendil-works/pi-mcp";
import type { ValidateFunction } from "ajv";
import { compileToolSchema } from "./schema.js";
import type { ToolAccess } from "../../application/business-ports.js";
import { AssistantError } from "../../application/ports.js";
import { canonical, object, type Json, type Parameters } from "../../domain/shared.js";

export type ConnectionConfig =
  | { transport: "http"; url: string; apiKeyEnv?: string; apiKeyHeader?: "X-API-Key" | "Authorization"; timeoutMs?: number }
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number };
export interface NativeTool { name: string; description: string; schema: Parameters; schemaDigest: string }
export function digest(value: Json): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function payload(result: CallToolResult): Json {
  if (result.structuredContent) return result.structuredContent as Json;
  for (const part of result.content) {
    if (part.type !== "text") continue;
    try { return JSON.parse(part.text) as Json; } catch { /* Preserve non-JSON content below. */ }
  }
  return JSON.parse(JSON.stringify(result)) as Json;
}
export function successful(result: CallToolResult): boolean {
  const data = payload(result);
  return result.isError !== true && !(object(data) && (data.success === false || data.isError === true));
}
/** Only this integration owns transports. No implicit reconnect or call retry. */
export class McpConnection {
  #epoch = randomUUID();
  get epoch(): string { return this.#epoch; }
  #catalogRevision = 0;
  #catalogInvalid = false;
  #access: ToolAccess | undefined;
  readonly #protectedWrites = new Set<string>();
  readonly #dispatches = new Map<string, { operation: string; parameters: Parameters; enter: () => void; started: boolean }>();
  readonly identity: string;
  readonly #client: McpClient;
  readonly #validators = new Map<string, ValidateFunction>();
  #tools: NativeTool[] = [];
  #unavailable: string[] = [];
  #closed = false;
  private constructor(client: McpClient, identity: string) {
    this.#client = client; this.identity = identity;
    client.onNotification("notifications/tools/list_changed", () => { this.#catalogRevision++; this.#catalogInvalid = true; this.#epoch = randomUUID(); });
  }
  static async connect(config: ConnectionConfig, options: { env?: Record<string, string>; cwd?: string; inheritEnv?: boolean; signal?: AbortSignal } = {}): Promise<McpConnection> {
    const resolvedEnv: Record<string, string> = { ...options.env };
    if (config.transport === "stdio") for (const [key, ref] of Object.entries(config.env ?? {})) {
      const value = process.env[ref];
      if (value === undefined) throw new AssistantError("CREDENTIAL_MISSING", "stdio 所需环境引用未设置。");
      resolvedEnv[key] = value;
    }
    const client = new McpClient({ name: "4-fire-assistant", version: "0.1.0", requestTimeoutMs: config.timeoutMs ?? 15000 });
    // The public identity is an opaque digest; paths, URL and headers are never model-visible.
    const connection = new McpConnection(client, digest(config.transport === "http" ?
      { transport: config.transport, url: config.url, apiKeyEnv: config.apiKeyEnv ?? null, apiKeyHeader: config.apiKeyHeader ?? "X-API-Key", credentialFingerprint: config.apiKeyEnv ? digest(process.env[config.apiKeyEnv] ?? "") : null } :
      { transport: config.transport, command: config.command, args: config.args ?? [], envDigest: digest(resolvedEnv) }));
    const cancel = () => { void client.close(); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      options.signal?.throwIfAborted();
      if (config.transport === "http") {
        const url = new URL(config.url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new AssistantError("INVALID_CONNECTION", "连接 URL 不允许凭证、查询参数或片段。");
        }
        const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
        if (config.apiKeyEnv && !key) throw new AssistantError("CREDENTIAL_MISSING", "连接凭证环境变量未设置；请在控制面配置，不要发送到模型对话。");
        await client.connect(new StreamableHttpTransport({ url, ...(key ? { headers: config.apiKeyHeader === "Authorization" ? { Authorization: `Bearer ${key}` } : { "X-API-Key": key } } : {}),
          openGetStream: false, reconnect: { maxRetries: 0 }, fetch: (input, init) => {
            if (init?.method === "POST" && typeof init.body === "string") connection.transportGate(JSON.parse(init.body));
            // Financial POSTs must never follow redirects to a different/second target.
            return fetch(input, { ...init, redirect: "error" });
          } }));
      } else {
        const transport = new StdioTransport({ command: config.command, args: config.args ?? [],
          ...(options.cwd ? { cwd: options.cwd } : {}), env: resolvedEnv,
          inheritEnv: options.inheritEnv ?? true, stderr: "pipe" });
        const guarded: McpTransport = { start: () => transport.start(), close: () => transport.close(),
          onMessage: listener => transport.onMessage(listener), onError: listener => transport.onError(listener), onClose: listener => transport.onClose(listener),
          send: message => { connection.transportGate(message); return transport.send(message); } };
        await client.connect(guarded);
      }
      await connection.refresh();
      return connection;
    } catch (error) {
      await client.close();
      if (error instanceof AssistantError) throw error;
      throw new AssistantError("CONNECTION_UNAVAILABLE", "MCP 初始化/发现失败；检查地址、认证、服务和超时。详细传输错误未暴露。");
    } finally { options.signal?.removeEventListener("abort", cancel); }
  }
  get connected(): boolean { return !this.#closed && this.#client.connectionState === "connected"; }
  get unavailableSchemas(): readonly string[] { return [...this.#unavailable]; }
  get schemaReady(): boolean { return !this.#catalogInvalid; }
  catalog(): NativeTool[] { return this.#catalogInvalid ? [] : structuredClone(this.#tools); }
  restrictTools(access: ToolAccess): void {
    if (this.#access) throw new AssistantError("ACCESS_ALREADY_SET", "连接分类已固定；修改配置后须重建连接。");
    if (Object.entries(access).some(([name, kind]) => !name.trim() || name !== name.trim() || !["read", "write"].includes(kind))) {
      throw new AssistantError("INVALID_TOOL_ACCESS", "工具分类只接受 read 或 write。");
    }
    this.#access = structuredClone(access);
    this.protectWrites(Object.keys(access).filter(name => access[name] === "write"));
  }
  private checkAccess(name: string): void {
    if (this.#access && !Object.hasOwn(this.#access, name)) throw new AssistantError("OPERATION_DENIED", "未分类工具不能调用。");
  }
  protectWrites(names: readonly string[]): void { names.forEach(name => this.#protectedWrites.add(name)); }
  private transportGate(message: unknown): void {
    if (!object(message) || message.method !== "tools/call" || !object(message.params) || typeof message.params.name !== "string") return;
    this.checkAccess(message.params.name);
    if (!this.#protectedWrites.has(message.params.name)) return;
    const parameters = (message.params.arguments ?? {}) as Parameters;
    const key = digest({ name: message.params.name, parameters });
    const pending = this.#dispatches.get(key);
    if (!pending || pending.started) throw new AssistantError("NATIVE_WRITE_BLOCKED", "原生写入没有当前单次发送许可，已在实际传输入口阻止。");
    this.validate(pending.operation, parameters);
    pending.enter();
    pending.started = true; // No await before the caller begins fetch/stdin.write.
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    const revision = this.#catalogRevision;
    const tools: Tool[] = await this.#client.listTools(signal ? { signal } : {});
    const discovered: NativeTool[] = [], unavailable: string[] = [];
    const validators = new Map<string, ValidateFunction>();
    for (const tool of tools) {
      try {
        if (validators.has(tool.name)) throw new Error("Duplicate tool");
        const schema = tool.inputSchema as Parameters;
        const validator = compileToolSchema(schema);
        validators.set(tool.name, validator);
        discovered.push({ name: tool.name, description: tool.description ?? "", schema: structuredClone(schema), schemaDigest: digest(schema) });
      } catch { unavailable.push(tool.name); validators.delete(tool.name); }
    }
    if (revision !== this.#catalogRevision) throw new AssistantError("SCHEMA_RACE", "发现期间工具发生变更；请重新查询目录，旧许可已失效。");
    if (digest(this.#tools.map(t => ({ name: t.name, description: t.description, schema: t.schema }))) !== digest(discovered.map(t => ({ name: t.name, description: t.description, schema: t.schema })))) this.#epoch = randomUUID();
    this.#catalogInvalid = false;
    this.#validators.clear();
    for (const [key, validator] of validators) if (!unavailable.includes(key)) this.#validators.set(key, validator);
    this.#tools = discovered.filter(t => !unavailable.includes(t.name));
    this.#unavailable = unavailable;
  }
  validate(name: string, parameters: Parameters): void {
    if (!this.connected) throw new AssistantError("CONNECTION_CLOSED", "连接已经关闭；旧许可不能用于重新连接。");
    if (this.#catalogInvalid) throw new AssistantError("SCHEMA_STALE", "远端宣布工具变更；需要重新发现，旧批准/许可无效。");
    canonical(parameters); // Reject non-finite, non-JSON values before any transport.
    const validate = this.#validators.get(name);
    if (!validate || !validate(parameters)) throw new AssistantError("SCHEMA_REJECTED", "操作不可用或完整参数不符合当前原生 schema；没有静默归一化或发送。");
  }
  /** Read/ordinary MCP entry; financial operations are separately protected at transport. */
  call(name: string, parameters: Parameters, signal?: AbortSignal): Promise<CallToolResult> {
    this.checkAccess(name);
    if (this.#protectedWrites.has(name)) throw new AssistantError("NATIVE_WRITE_BLOCKED", "金融原生写入只能经过单次发送门禁。");
    this.validate(name, parameters);
    return this.#client.callTool(name, structuredClone(parameters), signal ? { signal } : {}).catch(() => {
      throw new AssistantError("REMOTE_RESULT_UNKNOWN", "远端调用未取得可证明结果；副作用不能按失败重提。");
    });
  }
  async transmitOnce(name: string, parameters: Parameters, enter: () => void, signal?: AbortSignal): Promise<CallToolResult> {
    this.checkAccess(name);
    this.validate(name, parameters);
    if (!this.#protectedWrites.has(name)) throw new AssistantError("WRITE_NOT_CLASSIFIED", "操作未登记为受控写入。");
    const key = digest({ name, parameters });
    if (this.#dispatches.has(key)) throw new AssistantError("DISPATCH_BUSY", "已有同参数传输，不能并发建立替代发送。");
    const pending = { operation: name, parameters: structuredClone(parameters), started: false, enter: () => { signal?.throwIfAborted(); enter(); } };
    this.#dispatches.set(key, pending);
    try { return await this.#client.callTool(name, structuredClone(parameters), signal ? { signal } : {}); }
    catch {
      throw new AssistantError(pending.started ? "REMOTE_RESULT_UNKNOWN" : "PROVEN_NOT_SENT",
        pending.started ? "传输已开始，远端结果未知；不能重提。" : "实际传输门禁尚未通过，能够证明本次未发送；不自动重试。");
    } finally { this.#dispatches.delete(key); }
  }
  async close(): Promise<void> { this.#closed = true; await this.#client.close(); }
}

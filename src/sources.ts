import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { getAgentDir, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { canonical, digest, json, object, requireThat, schema, type Json, type Params } from "./values.js";
import type { Store } from "./storage.js";

export interface Operation {
  name: string; description: string; access: "read" | "write"; inputSchema: Params;
  argv?: (string | { parameter: string } | { json: true })[]; stdin?: boolean;
  outcomes?: { accepted: Params; rejected: Params };
}
export interface Source {
  id: string; kind: "cli" | "mcp"; command?: string; args?: string[]; url?: string;
  env?: Record<string, string>; headers?: Record<string, string>; operations: Operation[];
}
export interface Receipt {
  id: string; source: string; operation: string; parameters: Params; binding: string;
  at: string; success: boolean; data: Json;
}
export interface Observation { success: boolean; data: Json; raw?: Json }
const sourceSchema = schema({ type: "object", additionalProperties: false,
  required: ["id", "kind", "operations"], properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,47}$" }, kind: { enum: ["cli", "mcp"] },
    command: { type: "string", minLength: 1 }, args: { type: "array", items: { type: "string" } }, url: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string", pattern: "^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$" } },
    headers: { type: "object", additionalProperties: { type: "string", pattern: "^(Bearer )?\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$" } },
    operations: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
      required: ["name", "description", "access", "inputSchema"], properties: {
        name: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 }, access: { enum: ["read", "write"] },
        inputSchema: { type: "object" }, stdin: { type: "boolean" },
        argv: { type: "array", items: { anyOf: [ { type: "string" },
          { type: "object", required: ["parameter"], additionalProperties: false, properties: { parameter: { type: "string" } } },
          { type: "object", required: ["json"], additionalProperties: false, properties: { json: { const: true } } } ] } },
        outcomes: { type: "object", required: ["accepted", "rejected"], additionalProperties: false,
          properties: { accepted: { type: "object" }, rejected: { type: "object" } } }
      } } }
  } });
export function parseSource(value: unknown): Source {
  requireThat(sourceSchema(value), "来源配置无效。凭据只能引用 ${ENV_NAME}。");
  const source = structuredClone(value) as Source;
  requireThat(Boolean(source.command) !== Boolean(source.url), "来源必须指定 command 或 url，不能同时指定。");
  if (source.command) requireThat(isAbsolute(source.command) && !source.command.includes("\0"), "command 必须是绝对路径。");
  if (source.url) {
    const url = new URL(source.url);
    requireThat(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "URL 不得含凭据、查询或片段。");
  }
  requireThat(!source.url || !source.env && !source.args, "HTTP 来源不接受 env 或 args。");
  requireThat(!source.command || !source.headers, "本地来源不接受 headers。");
  const names = new Set<string>();
  for (const op of source.operations) {
    requireThat(!names.has(op.name), "操作名重复。"); names.add(op.name);
    requireThat(op.inputSchema.type === "object", "输入 schema 必须约束对象。"); schema(op.inputSchema);
    if (op.access === "write") requireThat(op.outcomes, "交易写入必须声明 accepted/rejected 回执 schema。");
    if (op.outcomes) { schema(op.outcomes.accepted); schema(op.outcomes.rejected); }
    if (source.kind === "cli") {
      requireThat(source.command && !source.args && !source.url && op.argv, "CLI 操作需要 command 和 argv；不接受来源级 args。");
      const whole = op.stdin || op.argv.some(token => object(token) && "json" in token);
      const properties = object(op.inputSchema.properties) ? op.inputSchema.properties : {};
      const bound = new Set(op.argv.flatMap(token => object(token) && "parameter" in token ? [token.parameter] : []));
      requireThat(whole || op.inputSchema.additionalProperties === false && Object.keys(properties).every(key => bound.has(key)), "CLI 参数必须全部绑定 argv 或 JSON 输入。");
    } else requireThat(op.argv === undefined && op.stdin === undefined, "MCP 不使用 argv 或 stdin 绑定。");
  }
  return source;
}
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = process.env[name]; requireThat(found !== undefined, "来源所需环境变量未设置。"); return found;
  });
}
function environment(source: Source) {
  return Object.fromEntries(Object.entries(source.env ?? {}).map(([key, value]) => [key, expand(value)]));
}
function payload(value: unknown): Json {
  if (object(value)) {
    if (value.structuredContent !== undefined) return json(value.structuredContent);
    if (Array.isArray(value.content)) {
      const texts = value.content.filter(p => object(p) && p.type === "text").map(p => p.text);
      if (texts.length === 1) { try { return json(JSON.parse(texts[0])); } catch { /* Retain native content. */ } }
    }
  }
  return json(value);
}
export async function runCommand(command: string, args: string[], input: string | undefined, cwd: string,
  env: Record<string, string>, signal?: AbortSignal): Promise<Observation> {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...env }, shell: false,
      detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0, failed = false;
    const out: Buffer[] = [], err: Buffer[] = [];
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ } } };
    const stop = () => { failed = true; kill(); };
    const timer = setTimeout(stop, 30_000);
    signal?.addEventListener("abort", stop, { once: true });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop(); else target.push(chunk);
    };
    child.stdout.on("data", collect(out)); child.stderr.on("data", collect(err));
    child.on("error", stop); child.stdin.on("error", stop);
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop); kill();
      const text = Buffer.concat(out).toString("utf8");
      let data: Json = { stdout: text, stderr: Buffer.concat(err).toString("utf8"), exitCode: code };
      try { data = JSON.parse(text) as Json; } catch { /* Preserve text and exit code. */ }
      resolve({ success: !failed && !signal?.aborted && code === 0, data, raw: { stdout: text, stderr: Buffer.concat(err).toString("utf8"), exitCode: code, incomplete: failed || !!signal?.aborted } });
    });
    if (signal?.aborted) stop(); child.stdin.end(input);
  });
}

/** Native read MCP uses Pi. Trading MCP is private and has no model-visible raw write tool. */
export class Sources {
  readonly #clients = new Map<string, McpClient>();
  readonly #epochs = new Map<string, string>();
  readonly #registered = new Set<string>();
  readonly #credentials = new Map<string, string>();
  readonly #connecting = new Map<string, Promise<McpClient>>();
  readonly #permits = new Map<string, { name: string; parameters: Params; enter: () => void; used: boolean }>();
  #closed = false;
  constructor(readonly root: string, readonly store: Store, private readonly pi: ExtensionAPI) {}
  list() { return this.store.list<Source>("source"); }
  source(id: string) { const source = this.store.get<Source>("source", id); requireThat(source, "来源未配置。"); return source; }
  operation(id: string, name: string) {
    const op = this.source(id).operations.find(op => op.name === name); requireThat(op, "操作未获接入许可。"); return op;
  }
  private epoch(id: string) {
    if (!this.#epochs.has(id)) this.#epochs.set(id, randomUUID());
    return this.#epochs.get(id)!;
  }
  private isPrivate(source: Source) { return source.operations.some(op => op.access === "write"); }
  register(source: Source) {
    if (source.kind !== "mcp" || this.isPrivate(source)) return;
    const name = "ffa_" + source.id;
    for (const path of [join(getAgentDir(), "mcp.json"), join(this.root, ".pi/mcp.json")]) {
      try {
        const config = JSON.parse(readFileSync(path, "utf8"));
        requireThat(!Object.keys(config.mcpServers ?? {}).some(key => key.replaceAll("-", "_") === name), "Pi MCP 配置覆盖了 FFA 来源名；请移除重复声明。");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.#credentials.set(source.id, this.credentials(source));
    this.pi.registerMcpServer(name, { ...(source.url ? { url: source.url, ...(source.headers ? { headers: source.headers } : {}) }
      : { command: source.command!, args: source.args ?? [], env: source.env ?? {}, cwd: this.root }),
      exposure: "hidden", toolExposure: Object.fromEntries(source.operations.map(op => [op.name, "codemode" as const])) });
    this.#registered.add(name);
  }
  async configure(source: Source) {
    source = parseSource(source);
    if (source.command) { await access(source.command, constants.X_OK); source.command = await realpath(source.command); }
    await this.#connecting.get(source.id)?.catch(() => undefined);
    await this.#clients.get(source.id)?.close(); this.#clients.delete(source.id); this.#epochs.delete(source.id);
    const name = "ffa_" + source.id;
    if (this.#registered.delete(name)) this.pi.unregisterMcpServer(name);
    this.store.put("source", source.id, source);
    this.register(source);
  }
  private credentials(source: Source) {
    return digest({ env: environment(source), headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  async binding(id: string, name: string, ctx?: ExtensionToolContext): Promise<string> {
    requireThat(!this.#closed, "来源已关闭。");
    const source = this.source(id), op = this.operation(id, name);
    let native: unknown = op.inputSchema;
    if (source.kind === "cli") await access(source.command!, constants.X_OK);
    else if (this.isPrivate(source)) {
      const client = await this.client(source);
      const tools = await client.listTools();
      const tool = tools.find(tool => tool.name === name); requireThat(tool, "MCP 操作不可用。");
      native = tool.inputSchema;
    } else {
      const tool = ctx?.tools.find(tool => tool.name === this.toolName(id, name));
      requireThat(tool, "Pi MCP 工具尚未就绪。请检查 /mcp 后重试查询。"); native = tool.parameters;
    }
    if (source.kind === "mcp") requireThat(this.#credentials.get(id) === this.credentials(source), "凭据引用已变化，请重新配置连接。");
    return this.fingerprint(source, native);
  }
  private fingerprint(source: Source, native: unknown) {
    return digest({ source, native, epoch: this.epoch(source.id), environment: environment(source), headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  toolName(id: string, name: string) { return "mcp__ffa_" + id + "__" + name.replace(/[^a-zA-Z0-9_]/g, "_"); }
  async client(source: Source): Promise<McpClient> {
    const current = this.#clients.get(source.id);
    if (current) { requireThat(this.#credentials.get(source.id) === this.credentials(source), "凭据引用已变化，请重新配置连接。"); return current; }
    const connecting = this.#connecting.get(source.id); if (connecting) return connecting;
    const promise = (async () => {
      const credential = this.credentials(source);
      const client = new McpClient({ name: "ffa", version: "0.2.0", requestTimeoutMs: 30_000 });
      client.onNotification("notifications/tools/list_changed", () => this.#epochs.set(source.id, randomUUID()));
      try {
        let transport: McpTransport;
        if (source.url) transport = new StreamableHttpTransport({ url: new URL(source.url),
          headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([k, v]) => [k, expand(v)])),
          reconnect: { maxRetries: 0 }, openGetStream: false,
          fetch: (input, init) => {
            if (init?.method === "POST" && typeof init.body === "string") this.transportGate(source.id, JSON.parse(init.body));
            return fetch(input, { ...init, redirect: "error" });
          } });
        else {
          const stdio = new StdioTransport({ command: source.command!, args: source.args ?? [], cwd: this.root, env: environment(source), inheritEnv: false, stderr: "pipe" });
          transport = { start: () => stdio.start(), close: () => stdio.close(), onMessage: f => stdio.onMessage(f),
            onError: f => stdio.onError(f), onClose: f => stdio.onClose(f),
            send: message => { this.transportGate(source.id, message); return stdio.send(message); } };
        }
        await client.connect(transport);
        requireThat(!this.#closed && credential === this.credentials(source), "来源已关闭或凭据在连接期间变化。");
        this.#credentials.set(source.id, credential); this.#clients.set(source.id, client); this.epoch(source.id); return client;
      } catch { await client.close(); throw new Error("MCP 连接失败；请检查服务和凭据引用。"); }
    })();
    this.#connecting.set(source.id, promise);
    try { return await promise; } finally { this.#connecting.delete(source.id); }
  }
  private transportGate(id: string, message: unknown) {
    if (!object(message) || message.method !== "tools/call") return;
    requireThat(object(message.params) && typeof message.params.name === "string", "无效的 MCP 调用。");
    const operation = this.operation(id, message.params.name);
    if (operation.access === "read") return;
    const permit = this.#permits.get(id);
    requireThat(permit && !permit.used && permit.name === operation.name && canonical(permit.parameters) === canonical(message.params.arguments ?? {}), "原生写入缺少单次发送许可。");
    permit.enter(); permit.used = true;
  }
  preview(id: string, name: string, parameters: Params): Json {
    const source = this.source(id), op = this.operation(id, name);
    requireThat(schema(op.inputSchema)(parameters), "参数不符合已确认 schema。"); canonical(parameters);
    if (source.kind === "mcp") return json({ source: id, server: source.url ?? source.command, args: source.args ?? [], tool: name, parameters });
    const argv = op.argv!.map(token => {
      if (typeof token === "string") return token;
      if ("json" in token) return canonical(parameters);
      const value = parameters[token.parameter];
      requireThat(["string", "boolean", "number"].includes(typeof value), "单个 argv 参数必须是标量。"); return String(value);
    });
    requireThat(argv.every(value => !value.includes("\0")), "argv 不得包含 NUL。");
    return json({ source: id, command: source.command, argv, stdin: op.stdin ? canonical(parameters) : null });
  }
  async read(id: string, name: string, parameters: Params, ctx: ExtensionToolContext, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted();
    requireThat(this.operation(id, name).access === "read", "查询入口不能执行写入。");
    const binding = await this.binding(id, name, ctx);
    const observation = await this.invoke(id, name, parameters, binding, ctx, signal);
    const receipt: Receipt = { id: randomUUID(), source: id, operation: name, parameters, binding,
      at: new Date().toISOString(), success: observation.success && !signal?.aborted && binding === await this.binding(id, name, ctx), data: observation.data };
    this.store.put("receipt", receipt.id, receipt); return receipt;
  }
  async send(id: string, name: string, parameters: Params, binding: string, enter: () => void, signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    requireThat(this.operation(id, name).access === "write", "操作不是交易写入。");
    requireThat(binding === await this.binding(id, name), "来源或参数结构已变化，请重新准备。");
    return this.invoke(id, name, parameters, binding, undefined, signal, enter);
  }
  private async invoke(id: string, name: string, parameters: Params, binding: string, ctx?: ExtensionToolContext, signal?: AbortSignal, enter?: () => void): Promise<Observation> {
    const source = this.source(id), op = this.operation(id, name), preview = this.preview(id, name, parameters) as Params;
    const gate = (native: unknown) => {
      signal?.throwIfAborted();
      requireThat(!this.#closed && canonical(source) === canonical(this.source(id)), "来源已变化。");
      requireThat(op.access === (enter ? "write" : "read"), "操作权限已变化，禁止调用。");
      requireThat(binding === this.fingerprint(source, native), "连接或参数结构已变化，请重新准备。");
      enter?.();
    };
    signal?.throwIfAborted();
    if (source.kind === "cli") {
      gate(op.inputSchema);
      return runCommand(source.command!, preview.argv as string[], this.operation(id, name).stdin ? canonical(parameters) : undefined, this.root, environment(source), signal);
    }
    if (this.isPrivate(source)) {
      const client = await this.client(source);
      const tool = (await client.listTools(signal ? { signal } : {})).find(t => t.name === name);
      requireThat(tool && schema(tool.inputSchema)(parameters), "参数不符合当前 MCP schema。");
      if (!enter) {
        gate(tool.inputSchema);
        const value = await client.callTool(name, parameters, signal ? { signal } : {});
        return { success: !value.isError, data: payload(value) };
      }
      requireThat(!this.#permits.has(id), "此来源已有待发送交易。");
      this.#permits.set(id, { name, parameters: structuredClone(parameters), enter: () => gate(tool.inputSchema), used: false });
      try {
        const value = await client.callTool(name, parameters, signal ? { signal } : {});
        requireThat(this.#permits.get(id)?.used, "实际传輸入口未消费许可。");
        return { success: !value.isError, data: payload(value) };
      } finally { this.#permits.delete(id); }
    }
    requireThat(ctx && !enter, "数据 MCP 不能发送交易。");
    gate(ctx.tools.find(tool => tool.name === this.toolName(id, name))?.parameters);
    const value = await ctx.executeTool(this.toolName(id, name), parameters, signal ? { signal } : {});
    return { success: !value.isError, data: payload(value) };
  }
  blocks(toolName: string) {
    if (!toolName.startsWith("mcp__")) return false;
    if (this.list().some(source => source.operations.some(op => op.access === "write" && toolName.endsWith("__" + op.name.replace(/[^a-zA-Z0-9_]/g, "_"))))) return true;
    if (!toolName.startsWith("mcp__ffa_")) return false;
    return !this.list().some(source => source.kind === "mcp" && !this.isPrivate(source) && source.operations.some(op => op.access === "read" && this.toolName(source.id, op.name) === toolName));
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#connecting.values()]);
    await Promise.allSettled([...this.#clients.values()].map(client => client.close())); this.#clients.clear();
    for (const name of this.#registered) this.pi.unregisterMcpServer(name); this.#registered.clear();
  }
}
export function classify(observation: Observation, operation: Operation): "accepted" | "rejected" | "unknown" {
  if (!observation.success || !operation.outcomes) return "unknown";
  const accepted = !!schema(operation.outcomes.accepted)(observation.data), rejected = !!schema(operation.outcomes.rejected)(observation.data);
  return accepted === rejected ? "unknown" : accepted ? "accepted" : "rejected";
}

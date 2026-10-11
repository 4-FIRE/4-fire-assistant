import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { canonical, json, object, type Params } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";
import type { Source } from "../model/source.js";
import { environment, expand, payload } from "./source-environment.js";

export class PrivateMcp {
  readonly #clients = new Map<string, McpClient>();
  readonly #connecting = new Map<string, Promise<McpClient>>();
  readonly #permits = new Map<string, { name: string; parameters: Params; enter: () => void; used: boolean }>();
  #closed = false;
  readonly #revisions = new Map<string, number>();
  constructor(private readonly root: string, private readonly credentials: (source: Source) => string,
    private readonly changed: (id: string) => void) {}
  readonly #credentials = new Map<string, string>();
  private async client(source: Source): Promise<McpClient> {
    requireThat(!this.#closed, "来源已关闭。");
    const current = this.#clients.get(source.id);
    if (current) {
      requireThat(this.#credentials.get(source.id) === this.credentials(source), "凭据引用已变化，请重新配置连接。");
      if (current.connectionState === "connected") return current;
      await current.close(); this.#clients.delete(source.id); this.#credentials.delete(source.id);
    }
    requireThat(!this.#closed, "来源已关闭。");
    const connecting = this.#connecting.get(source.id); if (connecting) return connecting;
    const promise = (async () => {
      const credential = this.credentials(source);
      const client = new McpClient({ name: "ffa", version: "0.2.0", requestTimeoutMs: 30_000 });
      client.onNotification("notifications/tools/list_changed", () => {
        this.#revisions.set(source.id, (this.#revisions.get(source.id) ?? 0) + 1); this.changed(source.id);
      });
      try {
        let transport: McpTransport;
        if (source.url) transport = new StreamableHttpTransport({ url: new URL(source.url),
          headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([k, v]) => [k, expand(v)])),
          reconnect: { maxRetries: 0 }, openGetStream: false,
          fetch: (input, init) => {
            if (init?.method === "POST" && typeof init.body === "string") this.transportGate(source, JSON.parse(init.body));
            return fetch(input, { ...init, redirect: "error" });
          } });
        else {
          const stdio = new StdioTransport({ command: source.command!, args: source.args ?? [], cwd: this.root, env: environment(source), inheritEnv: false, stderr: "pipe" });
          transport = { start: () => stdio.start(), close: () => stdio.close(), onMessage: f => stdio.onMessage(f),
            onError: f => stdio.onError(f), onClose: f => stdio.onClose(f),
            send: message => { this.transportGate(source, message); return stdio.send(message); } };
        }
        await client.connect(transport);
        requireThat(!this.#closed && credential === this.credentials(source), "来源已关闭或凭据在连接期间变化。");
        this.#credentials.set(source.id, credential); this.#clients.set(source.id, client); this.changed(source.id); return client;
      } catch { await client.close(); throw new Error("MCP 连接失败；请检查服务和凭据引用。"); }
    })();
    this.#connecting.set(source.id, promise);
    try { return await promise; } finally { this.#connecting.delete(source.id); }
  }
  private transportGate(source: Source, message: unknown) {
    if (!object(message) || message.method !== "tools/call") return;
    requireThat(object(message.params) && typeof message.params.name === "string", "无效的 MCP 调用。");
    const params = message.params;
    const permit = this.#permits.get(source.id);
    requireThat(permit && !permit.used && permit.name === params.name && canonical(permit.parameters) === canonical(message.params.arguments ?? {}), "原生调用缺少单次发送许可。");
    permit.enter(); permit.used = true;
  }

  async discover(source: Source, signal?: AbortSignal): Promise<Params[]> {
    signal?.throwIfAborted();
    const client = await this.client(source);
    signal?.throwIfAborted();
    const revision = this.#revisions.get(source.id);
    const tools = await client.listTools(signal ? { signal } : {});
    signal?.throwIfAborted();
    requireThat(revision === this.#revisions.get(source.id), "发现期间工具目录变化，请重新发现。");
    return tools.map(tool => json(tool) as Params);
  }
  async definition(source: Source, name: string, signal?: AbortSignal) {
    const tools = await this.discover(source, signal);
    const expected = source.operations.filter(op => op.available !== false).map(op => op.native);
    const sorted = (values: unknown[]) => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    requireThat(expected.every(Boolean) && canonical(sorted(tools)) === canonical(sorted(expected)), "MCP 目录已变化，请重新发现并分析。");
    const tool = tools.find(tool => tool.name === name);
    requireThat(tool, "MCP 操作不可用。"); return tool;
  }
  async invoke(source: Source, name: string, parameters: Params, gate: (native: unknown) => void,
    signal?: AbortSignal, write = false) {
    const client = await this.client(source);
    const tool = await this.definition(source, name, signal);
    const operation = source.operations.find(op => op.name === name);
    requireThat(operation && !operation.blocked && operation.assessment === "understood" && operation.effect === (write ? "change" : "observe"), "操作尚未获准用于此入口。");
    requireThat(schema(tool.inputSchema)(parameters), "参数不符合当前 MCP schema。");
    requireThat(!this.#permits.has(source.id), "此来源已有待发送调用，请按顺序执行。");
    this.#permits.set(source.id, { name, parameters: structuredClone(parameters), enter: () => gate(tool), used: false });
    try {
      const value = await client.callTool(name, parameters, signal ? { signal } : {});
      requireThat(this.#permits.get(source.id)?.used, "实际传輸入口未消费许可。");
      return { success: !value.isError, data: payload(value) };
    } finally { this.#permits.delete(source.id); }
  }
  async remove(id: string) {
    await this.#connecting.get(id)?.catch(() => undefined);
    await this.#clients.get(id)?.close(); this.#clients.delete(id); this.#credentials.delete(id);
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#connecting.values()]);
    const results = await Promise.allSettled([...this.#clients.values()].map(client => client.close()));
    this.#clients.clear();
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "来源 MCP 连接关闭失败。");
  }
}

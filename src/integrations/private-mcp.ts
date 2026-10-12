import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { canonical, json, object, type Params } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";
import type { Provider } from "../model/provider.js";
import { environment, expand, payload } from "./provider-environment.js";

export class PrivateMcp {
  readonly #clients = new Map<string, McpClient>();
  readonly #connecting = new Map<string, Promise<McpClient>>();
  readonly #permits = new Map<string, { name: string; parameters: Params; enter: () => void; used: boolean }>();
  #closed = false;
  readonly #revisions = new Map<string, number>();
  constructor(private readonly root: string, private readonly credentials: (provider: Provider) => string,
    private readonly changed: (id: string) => void) {}
  readonly #credentials = new Map<string, string>();
  private async client(provider: Provider): Promise<McpClient> {
    requireThat(!this.#closed, "能力提供方已关闭。");
    const current = this.#clients.get(provider.id);
    if (current) {
      requireThat(this.#credentials.get(provider.id) === this.credentials(provider), "凭据引用已变化，请重新配置连接。");
      if (current.connectionState === "connected") return current;
      await current.close(); this.#clients.delete(provider.id); this.#credentials.delete(provider.id);
    }
    requireThat(!this.#closed, "能力提供方已关闭。");
    const connecting = this.#connecting.get(provider.id); if (connecting) return connecting;
    const promise = (async () => {
      const credential = this.credentials(provider);
      const client = new McpClient({ name: "ffa", version: "0.2.0", requestTimeoutMs: 30_000 });
      client.onNotification("notifications/tools/list_changed", () => {
        this.#revisions.set(provider.id, (this.#revisions.get(provider.id) ?? 0) + 1); this.changed(provider.id);
      });
      try {
        let transport: McpTransport;
        if (provider.url) transport = new StreamableHttpTransport({ url: new URL(provider.url),
          headers: Object.fromEntries(Object.entries(provider.headers ?? {}).map(([k, v]) => [k, expand(v)])),
          reconnect: { maxRetries: 0 }, openGetStream: false,
          fetch: (input, init) => {
            if (init?.method === "POST" && typeof init.body === "string") this.transportGate(provider, JSON.parse(init.body));
            return fetch(input, { ...init, redirect: "error" });
          } });
        else {
          const stdio = new StdioTransport({ command: provider.command!, args: provider.args ?? [], cwd: this.root, env: environment(provider), inheritEnv: false, stderr: "pipe" });
          transport = { start: () => stdio.start(), close: () => stdio.close(), onMessage: f => stdio.onMessage(f),
            onError: f => stdio.onError(f), onClose: f => stdio.onClose(f),
            send: message => { this.transportGate(provider, message); return stdio.send(message); } };
        }
        await client.connect(transport);
        requireThat(!this.#closed && credential === this.credentials(provider), "能力提供方已关闭或凭据在连接期间变化。");
        this.#credentials.set(provider.id, credential); this.#clients.set(provider.id, client); this.changed(provider.id); return client;
      } catch { await client.close(); throw new Error("MCP 连接失败；请检查能力提供方和凭据引用。"); }
    })();
    this.#connecting.set(provider.id, promise);
    try { return await promise; } finally { this.#connecting.delete(provider.id); }
  }
  private transportGate(provider: Provider, message: unknown) {
    if (!object(message) || message.method !== "tools/call") return;
    requireThat(object(message.params) && typeof message.params.name === "string", "无效的 MCP 调用。");
    const params = message.params;
    const permit = this.#permits.get(provider.id);
    requireThat(permit && !permit.used && permit.name === params.name && canonical(permit.parameters) === canonical(message.params.arguments ?? {}), "原生调用缺少单次发送许可。");
    permit.enter(); permit.used = true;
  }

  async discover(provider: Provider, signal?: AbortSignal): Promise<Params[]> {
    signal?.throwIfAborted();
    const client = await this.client(provider);
    signal?.throwIfAborted();
    const revision = this.#revisions.get(provider.id);
    const tools = await client.listTools(signal ? { signal } : {});
    signal?.throwIfAborted();
    requireThat(revision === this.#revisions.get(provider.id), "发现期间工具目录变化，请重新发现。");
    return tools.map(tool => json(tool) as Params);
  }
  async definition(provider: Provider, name: string, signal?: AbortSignal) {
    const tools = await this.discover(provider, signal);
    const expected = provider.operations.filter(op => op.available !== false).map(op => op.native);
    const sorted = (values: unknown[]) => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    requireThat(expected.every(Boolean) && canonical(sorted(tools)) === canonical(sorted(expected)), "MCP 目录已变化，请重新发现。");
    const tool = tools.find(tool => tool.name === name);
    requireThat(tool, "MCP 操作不可用。"); return tool;
  }
  async invoke(provider: Provider, name: string, parameters: Params, gate: (native: unknown) => void,
    signal?: AbortSignal) {
    const client = await this.client(provider);
    const tool = await this.definition(provider, name, signal);
    const operation = provider.operations.find(op => op.name === name);
    requireThat(operation && operation.available !== false, "操作不可用。");
    requireThat(schema(tool.inputSchema)(parameters), "参数不符合当前 MCP schema。");
    requireThat(!this.#permits.has(provider.id), "此能力提供方已有待发送调用，请按顺序执行。");
    this.#permits.set(provider.id, { name, parameters: structuredClone(parameters), enter: () => gate(tool), used: false });
    try {
      const value = await client.callTool(name, parameters, signal ? { signal } : {});
      requireThat(this.#permits.get(provider.id)?.used, "实际传輸入口未消费许可。");
      return { success: !value.isError, data: payload(value) };
    } finally { this.#permits.delete(provider.id); }
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
    if (errors.length) throw new AggregateError(errors, "能力提供方 MCP 连接关闭失败。");
  }
}

import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { canonical, json, object, type Params } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";
import type { Operation, Provider } from "../../model/provider.js";
import { environment, expand, payload } from "./provider-environment.js";
import type { ProviderCallStrategy } from "./provider-call-strategy.js";

export class PrivateMcp implements ProviderCallStrategy {
  readonly #clients = new Map<string, McpClient>();
  readonly #connecting = new Map<string, Promise<McpClient>>();
  readonly #permits = new Map<string, { name: string; parameters: Params; enter: () => void; used: boolean }>();
  #closed = false;
  readonly #revisions = new Map<string, number>();
  readonly #catalogs = new Map<string, Params[]>();
  private invalidate(id: string) {
    this.#catalogs.delete(id);
    this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
    this.changed(id);
  }
  constructor(private readonly root: string, private readonly credentials: (provider: Provider) => string,
    private readonly changed: (id: string) => void) {}
  readonly #credentials = new Map<string, string>();

  environment(provider: Provider) {
    return environment(provider);
  }
  async prepare(provider: Provider) {
    if (!provider.command) return;
    await access(provider.command, constants.X_OK);
    provider.command = await realpath(provider.command);
  }
  preview(provider: Provider, operation: Operation, parameters: Params) {
    const server = provider.url ?? provider.command;
    requireThat(server, "MCP 需要服务器地址或命令。");
    return { provider: provider.id, server, args: [...(provider.args ?? [])], tool: operation.name,
      parameters: structuredClone(parameters) };
  }
  private async client(provider: Provider): Promise<McpClient> {
    requireThat(!this.#closed, "能力提供方已关闭。");
    const current = this.#clients.get(provider.id);
    if (current) {
      requireThat(this.#credentials.get(provider.id) === this.credentials(provider), "凭据引用已变化，请重新配置连接。");
      if (current.connectionState === "connected") return current;
      await current.close();
      this.#clients.delete(provider.id);
      this.#credentials.delete(provider.id);
      this.invalidate(provider.id);
    }
    requireThat(!this.#closed, "能力提供方已关闭。");
    const connecting = this.#connecting.get(provider.id);
    if (connecting) return connecting;
    const promise = (async () => {
      const credential = this.credentials(provider);
      const client = new McpClient({ name: "ffa", version: packageVersion, requestTimeoutMs: 30_000 });
      client.onNotification("notifications/tools/list_changed", () => this.invalidate(provider.id));
      client.onClose(() => this.invalidate(provider.id));
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
            send: message => {
              this.transportGate(provider, message);
              return stdio.send(message);
            } };
        }
        await client.connect(transport);
        requireThat(!this.#closed && credential === this.credentials(provider), "能力提供方已关闭或凭据在连接期间变化。");
        this.#credentials.set(provider.id, credential);
        this.#clients.set(provider.id, client);
        this.invalidate(provider.id);
        return client;
      } catch {
        await client.close();
        throw new Error("MCP 连接失败；请检查能力提供方和凭据引用。");
      }
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
    permit.enter();
    permit.used = true;
  }

  async discover(provider: Provider, signal?: AbortSignal, refresh = true): Promise<Params[]> {
    if (refresh) this.invalidate(provider.id);
    signal?.throwIfAborted();
    const client = await this.client(provider);
    signal?.throwIfAborted();
    const cached = this.#catalogs.get(provider.id);
    if (!refresh && cached) return structuredClone(cached);
    if (!refresh) this.invalidate(provider.id);
    const revision = this.#revisions.get(provider.id);
    const tools = await client.listTools(signal ? { signal } : {});
    signal?.throwIfAborted();
    requireThat(!this.#closed && client.connectionState === "connected" && revision === this.#revisions.get(provider.id), "发现期间连接或工具目录变化，请重新发现。");
    const catalog = tools.map(tool => json(tool) as Params);
    this.#catalogs.set(provider.id, catalog);
    return structuredClone(catalog);
  }
  async definition(provider: Provider, operation: Operation, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.client(provider);
    signal?.throwIfAborted();
    const tools = this.#catalogs.get(provider.id);
    requireThat(tools, "当前连接目录已失效，请重新提交调用或主动发现。");
    const tool = tools.find(tool => tool.name === operation.name), current = provider.operations.find(op => op.name === operation.name);
    requireThat(tool && current?.available !== false && current?.native && canonical(tool) === canonical(current.native), "MCP 操作或目录已变化，请重新提交调用。");
    return structuredClone(tool);
  }
  async invoke(provider: Provider, operation: Operation, parameters: Params, gate: (native: Params) => void,
    signal?: AbortSignal) {
    const client = await this.client(provider);
    const tool = await this.definition(provider, operation, signal);
    requireThat(schema(tool.inputSchema)(parameters), "参数不符合当前 MCP schema。");
    requireThat(!this.#permits.has(provider.id), "此能力提供方已有待发送调用，请按顺序执行。");
    const name = operation.name;
    this.#permits.set(provider.id, { name, parameters: structuredClone(parameters), enter: () => gate(tool), used: false });
    try {
      const value = await client.callTool(name, parameters, signal ? { signal } : {});
      requireThat(this.#permits.get(provider.id)?.used, "实际传輸入口未消费许可。");
      return { success: !value.isError, data: payload(value) };
    } finally { this.#permits.delete(provider.id); }
  }
  async remove(id: string) {
    await this.#connecting.get(id)?.catch(() => undefined);
    await this.#clients.get(id)?.close();
    this.#clients.delete(id);
    this.#credentials.delete(id);
    this.invalidate(id);
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#connecting.values()]);
    const results = await Promise.allSettled([...this.#clients.values()].map(client => client.close()));
    this.#clients.clear();
    this.#catalogs.clear();
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "能力提供方 MCP 连接关闭失败。");
  }
}

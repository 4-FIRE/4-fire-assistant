import { randomUUID } from "node:crypto";
import { canonical, json, type Params, type Json } from "../common/json.js";
import { toolId } from "../common/tool-id.js";
import { requireThat, schema } from "../common/validation.js";
import { Provider } from "../model/provider.js";
import type { Operation } from "../model/provider.js";
import type { Permission, Permissions } from "../model/permission.js";
import { Receipt } from "../model/receipt.js";
import type { Observation } from "../model/receipt.js";
import type { Store } from "../storage/store.js";
import type { ProviderAccess } from "./provider-access.js";
import { parseProvider, providerData } from "./provider-config.js";
import { checkCatalogEdit, connectionData, mergeCatalog } from "./provider-catalog.js";
import { PermissionService } from "./permission-service.js";

export class ProviderRegistry {
  #closed = false;
  readonly #editing = new Set<string>();
  readonly permissions: PermissionService;
  constructor(private readonly store: Store, private readonly access: ProviderAccess,
    private readonly invalidate: () => void, root: string) {
    this.permissions = new PermissionService(root, invalidate);
  }
  get notices() {
    return this.list().flatMap(provider => provider.kind === "mcp" && provider.discovery?.status !== "complete"
      ? [provider.id + "：目录未完成发现，请调用 ffa_discover_provider。"] : []);
  }
  list() { return this.store.list<Provider>("provider").map(value => new Provider(value)); }
  provider(id: string) {
    const value = this.store.get<Provider>("provider", id);
    requireThat(value, "能力提供方未配置。"); return new Provider(value);
  }
  operation(id: string, name: string) {
    const op = this.provider(id).operations.find(op => op.name === name);
    requireThat(op, "目录中没有此操作，请先发现完整能力。"); return op;
  }
  catalog(id?: string, name?: string) {
    requireThat(!name || id, "查看单个操作时需要指定 provider。");
    const providers = id ? [this.provider(id)] : this.list();
    const permissions = providers.length ? this.permissions.read() : undefined;
    return providers.map(provider => ({
      id: provider.id, kind: provider.kind, ...(provider.discovery ? { discovery: provider.discovery } : {}),
      ...(provider.coverage ? { coverage: provider.coverage } : {}),
      operations: (name ? [this.operation(provider.id, name)] : provider.operations).map(op => {
        const id = toolId(provider.id, op.name);
        return { ...op, id, permission: Object.hasOwn(permissions!.tools, id) ? permissions!.tools[id]! : permissions!.default };
      }),
    }));
  }
  private lock(id: string) {
    requireThat(!this.#closed && !this.#editing.has(id), "能力提供方已关闭或正在配置、发现，请按顺序执行。");
    this.#editing.add(id);
  }
  async configure(value: unknown, confirm: (provider: Provider, permissions: Permissions) => Promise<boolean>, signal?: AbortSignal,
    proposed: Record<string, Permission> = {}) {
    const provider = parseProvider(value);
    this.permissions.proposals(provider.id, provider.operations.map(op => op.name), proposed);
    this.lock(provider.id);
    try {
      const stored = this.store.get<Provider>("provider", provider.id), previous = stored ? new Provider(stored) : undefined;
      checkCatalogEdit(provider, previous);
      const changedConnection = previous && canonical(connectionData(provider)) !== canonical(connectionData(previous));
      if (provider.kind === "mcp" && changedConnection) {
        provider.operations = previous.operations.map(op => ({ ...op, available: false }));
        provider.discovery = { status: "stale", at: previous.discovery?.at ?? "", scope: "连接已变化，旧目录仅供参考，必须重新发现。" };
      }
      await this.permissions.initialize();
      const current = this.permissions.read(), next = structuredClone(current);
      for (const op of provider.operations) {
        const id = toolId(provider.id, op.name);
        if (!Object.hasOwn(next.tools, id)) next.tools[id] = proposed[id] ?? current.default;
      }
      this.invalidate();
      requireThat(await confirm(provider, next), "用户未确认配置。");
      signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
      this.invalidate(); await this.access.replace(provider);
      signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
      await this.permissions.addMissing(next.tools, current);
      this.store.put("provider", provider.id, providerData(provider));
      return provider.id;
    } finally { this.#editing.delete(provider.id); }
  }
  async discover(id: string, signal?: AbortSignal) {
    this.lock(id);
    try {
      const provider = this.provider(id);
      requireThat(provider.kind === "mcp", "CLI 无统一发现协议，请依据完整能力提供方文档配置目录及覆盖缺口。");
      try {
        const tools = await this.access.discover(provider, signal);
        signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
        const next = mergeCatalog(provider, tools);
        const definitions = (value: Provider) => value.operations.map(op => ({ ...op })).sort((a, b) => a.name.localeCompare(b.name));
        if (provider.discovery?.status !== "complete" || canonical(definitions(provider)) !== canonical(definitions(next))) {
          this.invalidate(); this.store.put("provider", id, providerData(next));
        }
      } catch (error) {
        if (!this.#closed) {
          this.invalidate();
          provider.discovery = { status: "failed", at: provider.discovery?.at ?? "", scope: "发现失败；旧目录保留，但不能作为当前完整目录使用。" };
          this.store.put("provider", id, providerData(provider));
        }
        throw error;
      }
      return this.catalog(id)[0]!;
    } finally { this.#editing.delete(id); }
  }
  permission(id: string, name: string) { return this.permissions.get(id, name); }
  async binding(id: string, name: string, signal?: AbortSignal) {
    requireThat(!this.#closed && !this.#editing.has(id), "能力提供方不可用。");
    if (this.provider(id).kind === "mcp") await this.discover(id, signal);
    const provider = this.provider(id), op = this.operation(id, name);
    this.allowed(provider, op);
    signal?.throwIfAborted();
    return this.access.binding(provider, op, signal);
  }
  private allowed(provider: Provider, op: Operation) {
    requireThat(op.available !== false && this.permission(provider.id, op.name) !== "deny", "操作不可用或被禁止。");
    requireThat(provider.kind !== "mcp" || provider.discovery?.status === "complete", "MCP 目录未完成发现。");
  }
  preview(id: string, name: string, parameters: Params): Json {
    const provider = this.provider(id), op = this.operation(id, name);
    this.allowed(provider, op);
    requireThat(schema(op.inputSchema)(parameters), "参数不符合当前 schema。"); canonical(parameters);
    if (provider.kind === "mcp") return json({ provider: id, server: provider.url ?? provider.command, args: provider.args ?? [], tool: name, parameters });
    requireThat(op.argv, "CLI 操作没有参数绑定。");
    const argv = op.argv.map(token => {
      if (typeof token === "string") return token;
      if ("json" in token) return canonical(parameters);
      const value = parameters[token.parameter];
      requireThat(["string", "boolean", "number"].includes(typeof value), "单个 argv 参数必须是标量。"); return String(value);
    });
    requireThat(argv.every(value => !value.includes("\0")), "argv 不得包含 NUL。");
    return json({ provider: id, command: provider.command, argv, stdin: op.stdin ? canonical(parameters) : null });
  }
  async send(id: string, name: string, parameters: Params, binding: string, permission: Permission, enter: () => void, signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted(); parameters = structuredClone(parameters);
    requireThat(binding === await this.binding(id, name, signal), "能力提供方或调用约定已变化，请重新准备。");
    const provider = this.provider(id), op = this.operation(id, name), preview = this.preview(id, name, parameters) as Params;
    const gate = (native: unknown) => {
      signal?.throwIfAborted();
      requireThat(!this.#closed && !this.#editing.has(id) && canonical(providerData(provider)) === canonical(providerData(this.provider(id))), "能力提供方已变化。");
      this.allowed(provider, op);
      requireThat(this.permission(id, name) === permission, "工具权限已变化，禁止调用。");
      requireThat(binding === this.access.identity(provider, native), "连接或定义已变化，请重新准备。");
      enter();
    };
    return this.access.invoke(provider, op, parameters, preview, gate, signal);
  }
  receipt(id: string, name: string, parameters: Params, binding: string, observation: Observation) {
    const receipt = new Receipt({ id: randomUUID(), provider: id, operation: name, parameters: structuredClone(parameters), binding,
      at: new Date().toISOString(), success: observation.success, data: observation.data });
    this.store.put("receipt", receipt.id, { ...receipt }); return receipt;
  }
  blocks(toolName: string) {
    if (!toolName.startsWith("mcp__")) return false;
    if (toolName.startsWith("mcp__ffa_")) return true;
    return this.list().some(provider => provider.kind === "mcp" && toolName.startsWith(`mcp__${provider.id}__`));
  }
  async close() { this.#closed = true; await this.access.close(); }
}
export function classify(observation: Observation, operation: Pick<Operation, "outcomes">): "accepted" | "rejected" | "unknown" {
  if (!observation.success) return "unknown";
  if (!operation.outcomes) return "accepted";
  const accepted = !!schema(operation.outcomes.accepted)(observation.data), rejected = !!schema(operation.outcomes.rejected)(observation.data);
  return accepted === rejected ? "unknown" : accepted ? "accepted" : "rejected";
}

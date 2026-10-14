import { canonical, json, type Params, type Json } from "../common/json.js";
import { toolId } from "../common/tool-id.js";
import { requireThat, schema } from "../common/validation.js";
import { Provider } from "../model/provider.js";
import type { Operation } from "../model/provider.js";
import type { ManagementRead, ManagementRequest, ManagementResult, ManagementConfirmation } from "../model/provider-management.js";
import { ProviderRevisions, ProviderEditError, conflict, connectionConfig, editableOperation, operationVersion, editProvider } from "./provider-edits.js";
import type { Observation } from "../model/receipt.js";
import type { Store } from "../storage/store.js";
import type { ProviderAccess } from "./provider-access.js";
import { parseProvider, providerData } from "./provider-config.js";
import { mergeCatalog } from "./provider-catalog.js";

import { PermissionService } from "./permission-service.js";

export class ProviderDiscoveryError extends Error {}

export class ProviderRegistry {
  #closed = false;
  readonly #editing = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #lifetime = new AbortController();
  #closing: Promise<void> | undefined;
  private async track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    try { return await work; } finally { this.#pending.delete(work); }
  }
  readonly permissions: PermissionService;
  constructor(private readonly store: Store, private readonly access: ProviderAccess, root: string) {
    this.permissions = new PermissionService(root);
  }
  get notices() {
    return this.list().flatMap(provider => provider.kind === "mcp" && provider.discovery?.status !== "complete"
      ? [provider.id + "：目录未完成发现，请使用 ffa_provider_manage 的 discover。"] : []);
  }
  list() { requireThat(!this.#closed, "能力提供方已关闭。"); return this.store.list<Provider>("provider").map(value => new Provider(value)); }
  provider(id: string) {
    requireThat(!this.#closed, "能力提供方已关闭。");
    const value = this.store.get<Provider>("provider", id);
    requireThat(value, "能力提供方未配置。"); return new Provider(value);
  }
  operation(id: string, name: string) {
    const op = this.provider(id).operations.find(op => op.name === name);
    requireThat(op, "operation：目录中没有此操作；MCP 使用 discover，CLI 使用 update operations。"); return op;
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
  readonly #revisions = new ProviderRevisions();

  readManagement(request: ManagementRead) {
    requireThat(!this.#closed, "能力提供方已关闭。");
    const provider = this.provider(request.provider), base = { provider: provider.id, action: "read" as const, target: request.target };
    const revision = (target: string, value: unknown) => this.#revisions.revision(`${provider.id}/${target}`, value);
    switch (request.target) {
      case "connection":
        return { ...base, config: connectionConfig(provider), revision: revision("connection", connectionConfig(provider)),
          state: { ...(provider.discovery ? { discovery: provider.discovery } : {}), limitations: this.notices.filter(notice => notice.startsWith(provider.id + "：")) } };
      case "coverage":
        requireThat(provider.kind === "cli", "target：coverage 仅用于 CLI。");
        return { ...base, coverage: provider.coverage!, revision: revision("coverage", provider.coverage) };
      case "operations": {
        requireThat(provider.kind === "cli", "target：可编辑接口仅用于 CLI，MCP 请查询能力目录。");
        const operations = request.operation ? [this.operation(provider.id, request.operation)] : provider.operations;
        return { ...base, operations: operations.map(op => ({ definition: editableOperation(op),
          revision: revision(`operations/${op.name}`, operationVersion(provider, op)) })),
          coverage: { value: provider.coverage!, revision: revision("coverage", provider.coverage) } };
      }
      case "outcomes": {
        const op = this.operation(provider.id, request.operation);
        return { ...base, operation: op.name, outcomes: op.outcomes ?? null,
          revision: revision(`outcomes/${op.name}`, operationVersion(provider, op)) };
      }
      case "permissions": {
        const value = this.permissionView(provider);
        return { ...base, ...value, revision: revision("permissions", { ...value, provider: providerData(provider) }) };
      }
    }
  }
  private permissionView(provider: Provider) {
    const config = this.permissions.read();
    const explicit = Object.fromEntries(provider.operations.flatMap(op => {
      const id = toolId(provider.id, op.name);
      return Object.hasOwn(config.tools, id) ? [[op.name, config.tools[id]!]] : [];
    }));
    return { default: config.default, explicit, effective: Object.fromEntries(provider.operations.map(op =>
      [op.name, Object.hasOwn(explicit, op.name) ? explicit[op.name]! : config.default])) };
  }
  private observeVersions(provider: Provider) {
    this.#revisions.revision(`${provider.id}/connection`, connectionConfig(provider));
    if (provider.kind === "cli") this.#revisions.revision(`${provider.id}/coverage`, provider.coverage);
    for (const op of provider.operations) {
      for (const target of ["operations", "outcomes"]) this.#revisions.revision(`${provider.id}/${target}/${op.name}`, operationVersion(provider, op));
    }
    this.#revisions.revision(`${provider.id}/permissions`, { ...this.permissionView(provider), provider: providerData(provider) });
  }
  manage(request: ManagementRequest, confirm: (value: ManagementConfirmation, recheck: () => Promise<void>, signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal) {
    return this.track(this.manageRequest(request, confirm, AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])])));
  }
  private async manageRequest(request: ManagementRequest, confirm: (value: ManagementConfirmation, recheck: () => Promise<void>, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal) {
    signal.throwIfAborted();
    requireThat(!this.#closed, "能力提供方已关闭。");
    if (request.action === "read") return this.readManagement(request);
    if (request.action === "discover") {
      const result: ManagementResult = { provider: request.provider, action: "discover" };
      await this.discoveryResult(result, signal); return result;
    }
    request = structuredClone(request);
    this.lock(request.provider);
    const result: ManagementResult = { provider: request.provider, action: request.action };
    let stage = "prepare", writing = false;
    try {
      const stored = this.store.get<Provider>("provider", request.provider);
      const previous = stored ? new Provider(stored) : undefined;
      let next: Provider, cleared: string[] = [];
      const permissionsOnly = request.action === "update" && request.target === "permissions";
      const reconnect = request.action === "register" || request.target === "connection";
      if (request.action === "register") {
        requireThat(!previous, "provider：已注册，请读取后使用 update。");
        requireThat(request.config.kind === "cli" || request.operations === undefined && request.coverage === undefined && request.permissions === undefined,
          "config：MCP 注册只接受连接配置，不接受目录或初始权限。");
        next = parseProvider({ ...request.config, id: request.provider, operations: request.operations ?? [],
          ...(request.coverage ? { coverage: request.coverage } : {}) });
        if (next.kind === "mcp") next.discovery = { status: "stale", at: "", scope: "连接已注册，尚未完成发现。" };
      } else {
        requireThat(previous, "provider：尚未注册。");
        if (request.target === "permissions") {
          this.#revisions.check(`${previous.id}/permissions`, { ...this.permissionView(previous), provider: providerData(previous) }, request.expectedRevision);
          next = previous;
        } else ({ next, cleared } = editProvider(previous, request, this.#revisions));
      }
      if (!permissionsOnly) result.configSaved = false;
      if (reconnect && next.kind === "mcp") result.discovery = { status: "not_started", limitations: [] };
      const changes = request.action === "register" ? request.permissions : request.target === "permissions" ? request.permissions : undefined;
      if (changes) result.permissions = { status: "not_started", applied: {}, preserved: {} };
      // Only an empty workspace may initialize its permission file. Existing workspaces fail closed.
      if (!this.list().length) await this.permissions.initialize();
      const current = this.permissions.read();
      const plan = changes ? this.permissions.plan(next.id, next.operations.map(op => op.name), changes,
        request.action === "update" && request.target === "permissions" ? request.mode : "suggest", current) : undefined;
      const snapshot = canonical(previous ? providerData(previous) : null);
      const recheck = () => {
        signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
        const actual = this.store.get<Provider>("provider", next.id);
        if (canonical(actual ?? null) !== snapshot || canonical(this.permissions.read()) !== canonical(current)) conflict(next.id);
      };
      stage = "confirmation";
      const accepted = await confirm({ action: request.action, ...(request.action === "update" ? { target: request.target } : {}),
        provider: { ...next, operations: next.operations.map(op => ({ ...op })) }, clearedOutcomes: cleared,
        permissions: { before: current, after: plan?.next ?? current, applied: plan?.applied ?? {}, preserved: plan?.preserved ?? {} } }, async () => recheck(), signal);
      recheck();
      if (!accepted) {
        result.error = { category: "declined", path: "", message: "用户未确认本次变更。", next: "等待用户决定，不自动重试。" };
        return result;
      }
      if (reconnect) {
        stage = "connection"; await this.access.replace(next); recheck();
      }
      if (plan && result.permissions) {
        stage = "permissions"; writing = true;
        // A failed durable write cannot be inferred to have rolled back from current file contents.
        result.permissions.status = "unknown";
        await this.permissions.save(plan.next, current);
        result.permissions = { status: "complete", applied: plan.applied, preserved: plan.preserved };
        writing = false;
      }
      signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
      if (canonical(this.store.get("provider", next.id) ?? null) !== snapshot ||
          canonical(this.permissions.read()) !== canonical(plan?.next ?? current)) conflict(next.id);
      if (!permissionsOnly) {
        stage = "config"; writing = true; result.configSaved = null;
        try { this.store.put("provider", next.id, providerData(next)); result.configSaved = true; }
        catch (error) {
          // SQLite statement failures are atomic; report false only if the prior value is still readable.
          try { if (canonical(providerData(next)) !== snapshot && canonical(this.store.get("provider", next.id) ?? null) === snapshot) result.configSaved = false; } catch { /* unknown */ }
          throw error;
        }
        writing = false;
      }
      this.observeVersions(next);
      if (request.action === "update") {
        const read: ManagementRead = request.target === "outcomes"
          ? { action: "read", provider: next.id, target: "outcomes", operation: request.operation }
          : { action: "read", provider: next.id, target: request.target };
        result.saved = this.readManagement(read);
      } else result.saved = this.readManagement({ action: "read", provider: next.id, target: "connection" });
    } catch (error) {
      signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
      if (error instanceof ProviderEditError) result.error = error.failure;
      else if (stage === "prepare" || stage === "confirmation") throw error;
      else result.error = { category: writing || stage === "permissions" || stage === "config" ? "storage" : "connection",
        path: stage, message: "本阶段未可靠完成；已完成的阶段不会自动回滚。", next: "读取对应状态并核对，不自动重复提交。" };
    } finally { this.#editing.delete(request.provider); }
    if (!result.error && result.discovery) {
      await this.discoveryResult(result, signal);
      result.saved = this.readManagement({ action: "read", provider: request.provider, target: "connection" });
    }
    return result;
  }
  private async discoveryResult(result: ManagementResult, signal?: AbortSignal) {
    try {
      await this.discover(result.provider, signal);
      result.discovery = { status: "complete", limitations: ["仅包含当前连接和凭据可见的 MCP 工具。"] };
    } catch (error) {
      signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
      if (!(error instanceof ProviderDiscoveryError)) {
        if (result.configSaved === true || !this.store.healthy) {
          delete result.discovery;
          result.error = { category: "storage", path: "discovery", message: "发现阶段未可靠保存，不能作为普通远端失败处理。", next: "停止调用，核对存储和已注册配置；不要重复注册。" };
          return;
        }
        throw error;
      }
      result.discovery = { status: "failed", limitations: ["连接仍已注册；旧目录保留，但不能发送。"] };
      result.error = { category: "discovery", path: "discovery", message: "目录发现失败。", next: "连接和认证无须修改时使用 discover，不要重复注册。" };
    }
  }
  discover(id: string, signal?: AbortSignal, refresh = true) {
    return this.track(this.discoverCatalog(id, AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]), refresh));
  }
  private async discoverCatalog(id: string, signal: AbortSignal, refresh: boolean) {
    signal.throwIfAborted();
    this.lock(id);
    try {
      const provider = this.provider(id);
      requireThat(provider.kind === "mcp", "provider：CLI 目录请使用 update operations 维护。");
      let next: Provider;
      try {
        const tools = await this.access.discover(provider, signal, refresh);
        signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
        next = mergeCatalog(provider, tools);
      } catch (error) {
        signal.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
        provider.discovery = { status: "failed", at: provider.discovery?.at ?? "", scope: "发现失败；旧目录保留，但不能发送。" };
        this.store.put("provider", id, providerData(provider));
        throw new ProviderDiscoveryError("MCP 目录发现失败。", { cause: error });
      }
      const definitions = (value: Provider) => value.operations.map(op => ({ ...op })).sort((a, b) => a.name.localeCompare(b.name));
      if (provider.discovery?.status !== "complete" || canonical(definitions(provider)) !== canonical(definitions(next))) {
        this.store.put("provider", id, providerData(next));
        this.observeVersions(next);
      }
      return this.catalog(id)[0]!;
    } finally { this.#editing.delete(id); }
  }
  permission(id: string, name: string) { return this.permissions.get(id, name); }
  async binding(id: string, name: string, signal?: AbortSignal) {
    requireThat(!this.#closed && !this.#editing.has(id), "能力提供方不可用。");
    const current = this.provider(id);
    if (current.kind === "mcp") await this.discover(id, signal, current.discovery?.status !== "complete");
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
  async send(id: string, name: string, parameters: Params, binding: string, permissions: string, enter: () => void, signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted(); parameters = structuredClone(parameters);
    requireThat(!this.#closed && !this.#editing.has(id), "能力提供方不可用。");
    const provider = this.provider(id), op = this.operation(id, name), preview = this.preview(id, name, parameters) as Params;
    requireThat(binding === await this.access.binding(provider, op, signal), "连接或目录已变化，请重新提交调用。");
    const gate = (native: unknown) => {
      signal?.throwIfAborted();
      requireThat(!this.#closed && !this.#editing.has(id) && canonical(providerData(provider)) === canonical(providerData(this.provider(id))), "能力提供方已变化。");
      this.allowed(provider, op);
      requireThat(canonical(this.permissions.read()) === permissions, "工具权限已变化，禁止调用。");
      requireThat(binding === this.access.identity(provider, native), "连接或目录已变化，请重新提交调用。");
      enter();
    };
    return this.access.invoke(provider, op, parameters, preview, gate, signal);
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#lifetime.abort(); this.#revisions.clear();
    this.#closing = (async () => {
      try { await this.access.close(); }
      finally { await Promise.allSettled([...this.#pending]); }
    })();
    return this.#closing;
  }
}
export function classify(observation: Observation, operation: Pick<Operation, "outcomes">): "accepted" | "rejected" | "unknown" {
  if (!observation.success) return "unknown";
  if (!operation.outcomes) return "accepted";
  const accepted = !!schema(operation.outcomes.accepted)(observation.data), rejected = !!schema(operation.outcomes.rejected)(observation.data);
  return accepted === rejected ? "unknown" : accepted ? "accepted" : "rejected";
}

import { randomUUID } from "node:crypto";
import { canonical, json, type Params, type Json } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";
import { Source } from "../model/source.js";
import type { Operation } from "../model/source.js";
import { Receipt } from "../model/receipt.js";
import type { Observation } from "../model/receipt.js";
import type { Store } from "../storage/store.js";
import type { SourceAccess } from "./source-access.js";
import { parseSource, sourceData } from "./source-config.js";
import { checkCatalogEdit, connectionData, mergeCatalog } from "./source-catalog.js";

export class SourceService {
  #closed = false;
  readonly #editing = new Set<string>();
  constructor(private readonly store: Store, private readonly access: SourceAccess,
    private readonly invalidate: () => void) {}
  get notices() {
    return this.list().flatMap(source => [
      ...(source.kind === "mcp" && source.discovery?.status !== "complete" ? [source.id + "：目录未完成发现，请调用 ffa_discover_source。"] : []),
      ...(source.operations.some(op => op.effect === "unresolved") ? [source.id + "：有待分析或待确认能力，不能执行。"] : []),
    ]);
  }
  list() { return this.store.list<Source>("source").map(value => new Source(value)); }
  source(id: string) {
    const value = this.store.get<Source>("source", id);
    requireThat(value, "来源未配置。"); return new Source(value);
  }
  operation(id: string, name: string) {
    const op = this.source(id).operations.find(op => op.name === name);
    requireThat(op, "目录中没有此操作，请先发现完整能力。"); return op;
  }
  catalog(id?: string, name?: string) {
    requireThat(!name || id, "查看单个操作时需要指定 source。");
    return (id ? [this.source(id)] : this.list()).map(source => ({
      id: source.id, kind: source.kind, ...(source.discovery ? { discovery: source.discovery } : {}),
      ...(source.coverage ? { coverage: source.coverage } : {}),
      operations: name ? [this.operation(source.id, name)] : source.operations,
    }));
  }
  private lock(id: string) {
    requireThat(!this.#closed && !this.#editing.has(id), "来源已关闭或正在配置、发现，请按顺序执行。");
    this.#editing.add(id);
  }
  async configure(value: unknown, confirm: (source: Source) => Promise<boolean>, signal?: AbortSignal) {
    const source = parseSource(value);
    this.lock(source.id);
    try {
      const stored = this.store.get<Source>("source", source.id), previous = stored ? new Source(stored) : undefined;
      checkCatalogEdit(source, previous);
      const changedConnection = previous && canonical(connectionData(source)) !== canonical(connectionData(previous));
      if (source.kind === "mcp" && changedConnection) {
        source.operations = previous.operations.map(op => ({ ...op, available: false, effect: "unresolved", assessment: "unassessed" }));
        source.discovery = { status: "stale", at: previous.discovery?.at ?? "", scope: "连接已变化，旧目录仅供参考，必须重新发现。" };
      }
      this.invalidate();
      requireThat(await confirm(source), "用户未确认配置。");
      signal?.throwIfAborted(); requireThat(!this.#closed, "来源已关闭。");
      this.invalidate(); await this.access.replace(source);
      signal?.throwIfAborted(); requireThat(!this.#closed, "来源已关闭。");
      this.store.put("source", source.id, sourceData(source));
      return source.id;
    } finally { this.#editing.delete(source.id); }
  }
  async discover(id: string, signal?: AbortSignal) {
    this.lock(id);
    try {
      const source = this.source(id);
      requireThat(source.kind === "mcp", "CLI 无统一发现协议，请依据完整文档配置目录和覆盖缺口。");
      try {
        const tools = await this.access.discover(source, signal);
        signal?.throwIfAborted(); requireThat(!this.#closed, "来源已关闭。");
        const next = mergeCatalog(source, tools);
        // A fresh timestamp alone must not invalidate an in-flight evidence binding.
        const definitions = (value: Source) => value.operations.map(op => ({ ...op })).sort((a, b) => a.name.localeCompare(b.name));
        if (source.discovery?.status !== "complete" || canonical(definitions(source)) !== canonical(definitions(next))) {
          this.invalidate(); this.store.put("source", id, sourceData(next));
        }
      } catch (error) {
        if (!this.#closed) {
          this.invalidate();
          source.discovery = { status: "failed", at: source.discovery?.at ?? "", scope: "发现失败；旧目录保留，但不能作为当前完整目录使用。" };
          this.store.put("source", id, sourceData(source));
        }
        throw error;
      }
      return this.catalog(id)[0]!;
    } finally { this.#editing.delete(id); }
  }
  async binding(id: string, name: string, signal?: AbortSignal) {
    requireThat(!this.#closed && !this.#editing.has(id), "来源不可用。");
    if (this.source(id).kind === "mcp") await this.discover(id, signal);
    const source = this.source(id), op = this.operation(id, name);
    this.allowed(op);
    signal?.throwIfAborted();
    return this.access.binding(source, op, signal);
  }
  private allowed(op: Operation) {
    requireThat(op.available !== false && !op.blocked && op.assessment === "understood" && op.effect !== "unresolved", "操作不可用、被禁止或尚未明确影响。");
  }
  preview(id: string, name: string, parameters: Params): Json {
    const source = this.source(id), op = this.operation(id, name);
    this.allowed(op);
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
  async read(id: string, name: string, parameters: Params, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted(); parameters = structuredClone(parameters);
    requireThat(this.operation(id, name).effect === "observe", "观察入口不能执行变更或未知操作。");
    const binding = await this.binding(id, name, signal);
    const observation = await this.invoke(id, name, parameters, binding, signal);
    const receipt = new Receipt({ id: randomUUID(), source: id, operation: name, parameters, binding,
      at: new Date().toISOString(), success: observation.success && !signal?.aborted && binding === await this.binding(id, name, signal), data: observation.data });
    this.store.put("receipt", receipt.id, { ...receipt }); return receipt;
  }
  async send(id: string, name: string, parameters: Params, binding: string, enter: () => void, signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted(); parameters = structuredClone(parameters);
    requireThat(this.operation(id, name).effect === "change", "操作不是变更。");
    requireThat(binding === await this.binding(id, name, signal), "来源或调用约定已变化，请重新准备。");
    return this.invoke(id, name, parameters, binding, signal, enter);
  }
  private async invoke(id: string, name: string, parameters: Params, binding: string, signal?: AbortSignal, enter?: () => void) {
    const source = this.source(id), op = this.operation(id, name), preview = this.preview(id, name, parameters) as Params;
    const gate = (native: unknown) => {
      signal?.throwIfAborted();
      requireThat(!this.#closed && !this.#editing.has(id) && canonical(sourceData(source)) === canonical(sourceData(this.source(id))), "来源已变化。");
      this.allowed(op);
      requireThat(op.effect === (enter ? "change" : "observe"), "操作权限已变化，禁止调用。");
      requireThat(binding === this.access.identity(source, native), "连接或定义已变化，请重新准备。");
      enter?.();
    };
    return this.access.invoke(source, op, parameters, preview, gate, signal, !!enter);
  }
  blocks(toolName: string) {
    if (!toolName.startsWith("mcp__")) return false;
    if (toolName.startsWith("mcp__ffa_")) return true;
    return this.list().some(source => source.operations.some(op => op.effect !== "observe" &&
      toolName.endsWith("__" + op.name.replace(/[^a-zA-Z0-9_]/g, "_"))));
  }
  async close() { this.#closed = true; await this.access.close(); }
}
export function classify(observation: Observation, operation: Pick<Operation, "outcomes">): "accepted" | "rejected" | "unknown" {
  if (!observation.success || !operation.outcomes) return "unknown";
  const accepted = !!schema(operation.outcomes.accepted)(observation.data), rejected = !!schema(operation.outcomes.rejected)(observation.data);
  return accepted === rejected ? "unknown" : accepted ? "accepted" : "rejected";
}

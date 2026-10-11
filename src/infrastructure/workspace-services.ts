import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AssistantError } from "../application/ports.js";
import type { ToolPort, DispatchPermit } from "../application/business-ports.js";
import { canonical, type Evidence, type Json, type OperationSpec, type Scope } from "../domain/shared.js";
import { validInitializationEvidence, type WorkspaceConfig, type WorkspaceSource } from "../domain/workspace.js";
import { parseWorkspaceSource, readWorkspace, saveWorkspace } from "./workspace.js";
import { parseSourceConnection } from "./integrations/connection-config.js";
import { openSource, parseToolContract } from "./tool-contracts.js";
import { validateWorkspaceDocuments } from "./resources.js";
import { ToolSources } from "./integrations/tool-sources.js";

async function requireDocument(path: string): Promise<void> {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new AssistantError("SOURCE_GUIDE_REQUIRED", `请保存所需文档：${path}`);
    throw new AssistantError("SOURCE_GUIDE_UNREADABLE", `无法读取文档：${path}（${code ?? "UNKNOWN"}）。请检查文件和访问权限。`);
  }
  if (!content.trim()) throw new AssistantError("SOURCE_GUIDE_REQUIRED", `文档不能为空：${path}`);
}

export type ConfirmAction = (description: string, details: string, signal?: AbortSignal) => Promise<boolean>;

/** One workspace-owned source set. Changing a source never resets initialization. */
export class WorkspaceServices implements ToolPort {
  private readonly opened = new Map<string, Awaited<ReturnType<typeof openSource>>>();
  private readonly failures = new Map<string, string>();
  private tools = new ToolSources(new Map());
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: string, private config: WorkspaceConfig, private readonly confirm: ConfirmAction) {}
  static async open(directory: string, confirm: ConfirmAction): Promise<WorkspaceServices> {
    const services = new WorkspaceServices(directory, await readWorkspace(directory), confirm);
    for (const [id, source] of Object.entries(services.config.sources)) {
      try { services.opened.set(id, await services.connect(id, source)); }
      catch (error) { services.failures.set(id, error instanceof AssistantError ? error.code : "CONNECTION_UNAVAILABLE"); }
    }
    services.rebuild();
    return services;
  }
  get root(): string { return dirname(this.directory); }
  get initialized(): boolean { return this.config.initialization !== null; }
  get extensions() { return this.config.extensions; }
  private rebuild() { this.tools = new ToolSources(new Map([...this.opened].map(([id, source]) => [id, source.tools]))); }
  private connect(id: string, source: WorkspaceSource, signal?: AbortSignal) {
    return openSource(parseSourceConnection(source.connection), parseToolContract({ version: 1, sourceId: id, operations: source.operations }), this.root, signal);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work); this.tail = next.catch(() => {}); return next;
  }
  async configure(id: string, input: unknown, signal?: AbortSignal): Promise<Json> {
    const source = parseWorkspaceSource(id, input);
    return this.serialize(async () => {
      if (!await this.confirm("接入或修复服务来源。此确认不授予交易许可。", JSON.stringify({ id, ...source }, null, 2), signal)) return { changed: false };
      signal?.throwIfAborted();
      const opened = await this.connect(id, source, signal);
      try {
        signal?.throwIfAborted();
        const next = { ...this.config, sources: { ...this.config.sources, [id]: source } };
        await saveWorkspace(this.directory, next);
        this.config = next;
      } catch (error) { await opened.close(); throw error; }
      const old = this.opened.get(id);
      this.opened.set(id, opened); this.failures.delete(id); this.rebuild();
      await old?.close();
      return { changed: true, id, operations: this.catalog().filter(op => op.name.startsWith(id + "/")) as unknown as Json };
    });
  }
  async remove(id: string, signal?: AbortSignal): Promise<Json> {
    return this.serialize(async () => {
      if (!Object.hasOwn(this.config.sources, id)) throw new AssistantError("SOURCE_MISSING", "此服务来源不存在。");
      if (!await this.confirm("移除服务来源。资料和交易记录会保留。", id, signal)) return { changed: false };
      signal?.throwIfAborted();
      const next = structuredClone(this.config); delete next.sources[id];
      await saveWorkspace(this.directory, next); this.config = next;
      const old = this.opened.get(id); this.opened.delete(id); this.failures.delete(id); this.rebuild(); await old?.close();
      return { changed: true };
    });
  }
  async finish(market: string, quote: Evidence | undefined, history: Evidence | undefined, signal?: AbortSignal): Promise<Json> {
    return this.serialize(async () => {
      if (this.initialized) return { completed: true, initialization: this.config.initialization as unknown as Json };
      if (!market.trim()) throw new AssistantError("INITIALIZATION_EVIDENCE_REQUIRED", "请提供目标市场和实际查询的回执。");
      const check = async () => {
        for (const evidence of [quote, history]) {
          if (!evidence || this.kind(evidence.operation) !== "read" || !validInitializationEvidence(evidence, this.binding(evidence.operation))) {
            throw new AssistantError("INITIALIZATION_EVIDENCE_REQUIRED", "请提供通过当前连接成功查询行情和历史 K 线的记录。帮助信息、文档和旧连接的回执不能代替查询记录。");
          }
          const id = evidence.operation.split("/")[0]!;
          await requireDocument(join(this.root, "sources", id, "GUIDE.md"));
        }
        await validateWorkspaceDocuments(this.root);
      };
      await check();
      const snapshot = canonical(this.config.sources as unknown as Json);
      if (!await this.confirm("确认完成工作区初始化。请核对模型对行情和历史 K 线的解释。程序只检查实际调用记录，不能判断各服务返回数据的含义。", JSON.stringify({ market, quote, history }, null, 2), signal)) return { completed: false };
      signal?.throwIfAborted();
      if (snapshot !== canonical(this.config.sources as unknown as Json)) throw new AssistantError("SOURCE_CHANGED", "服务连接已变化。请重新验证行情和历史 K 线查询。");
      await check();
      const next = { ...this.config, initialization: { market, quoteRef: quote!.ref, historyRef: history!.ref, completedAt: new Date().toISOString() } };
      await saveWorkspace(this.directory, next); this.config = next;
      return { completed: true, initialization: next.initialization };
    });
  }
  requireInitialized(): void { if (!this.initialized) throw new AssistantError("INITIALIZATION_REQUIRED", "请先连接数据服务，再验证行情和历史 K 线查询。验证后，完成工作区初始化。"); }
  status(): Json { return { initialization: this.config.initialization as unknown as Json, sources: this.tools.status(), unavailable: Object.fromEntries(this.failures) }; }
  catalog() { return this.tools.catalog(); }
  kind(name: string) { return this.tools.kind(name); }
  allowed(name: string, role: string) { return this.tools.allowed(name, role); }
  requirements(name: string) { return this.tools.requirements(name); }
  binding(name: string) { return this.tools.binding(name); }
  preview(operation: OperationSpec) {
    const id = operation.name.split("/")[0]!;
    return { connection: this.config.sources[id]!.connection, ...this.tools.preview(operation) };
  }
  refresh(signal?: AbortSignal) { return this.tools.refresh(signal); }
  validate(operation: OperationSpec) { return this.tools.validate(operation); }
  read(operation: OperationSpec, signal?: AbortSignal) { return this.tools.read(operation, signal); }
  dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal) {
    this.requireInitialized(); return this.tools.dispatch(permit, operation, scope, signal);
  }
  async close() { await this.tail; await Promise.allSettled([...this.opened.values()].map(source => source.close())); }
}

import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { requireThat } from "../common/validation.js";
import { Scope } from "../model/execution-intent.js";
import type { WorkspaceState } from "../model/workspace.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { InitializationService } from "../services/initialization-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { RecordService } from "../services/record-service.js";
import type { ExpertService } from "../services/expert-service.js";
import { startInitialization, prepareDirectories } from "../services/initialization-service.js";
import { state } from "../storage/workspace-state.js";
import type { Store } from "../storage/store.js";
import type { CallAccess } from "../tools/access.js";

export class WorkspaceInstance implements CallAccess {
  readonly #controller = new AbortController();
  #request = randomUUID();
  #closing: Promise<void> | undefined;
  constructor(readonly root: string, private readonly store: Store, readonly providers: ProviderRegistry,
    readonly execution: ExecutionService, readonly initialization: InitializationService,
    readonly research: ResearchService, readonly records: RecordService, readonly experts: ExpertService) {}
  check(ready = false) {
    requireThat(!this.#controller.signal.aborted, "ffa 未启用；请执行 /ffa init。");
    requireThat(!ready || this.initialization.snapshot().status === "ready", "请先完成工作区初始化。");
  }
  signal(signal?: AbortSignal) {
    this.check(); return signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
  }
  scope(session: string) { this.check(); return new Scope(session, this.#request); }
  newRequest() { this.check(); this.#request = randomUUID(); this.execution.revoke(); }
  revoke() { this.execution.revoke(); }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.revoke(); this.#controller.abort();
    this.#closing = (async () => {
      try { await this.providers.close(); } finally { this.store.close(); }
    })();
    return this.#closing;
  }
}
export class Lifecycle {
  #active: WorkspaceInstance | undefined;
  constructor(private readonly create: (root: string, current: WorkspaceState) => WorkspaceInstance,
    private readonly register: (instance: WorkspaceInstance) => void, private readonly hide: () => void) {}
  get active() { return this.#active; }
  get() {
    requireThat(this.#active, "ffa 未启用；请执行 /ffa init。");
    this.#active.check(); return this.#active;
  }
  inspect(root: string) { return state(root); }
  async open(root: string, current: WorkspaceState) {
    await this.close();
    const instance = this.create(await realpath(root), current);
    this.#active = instance;
    try { this.register(instance); }
    catch (error) { await this.close(); throw error; }
  }
  async start(root: string, confirm: (value: unknown, continuing: boolean) => Promise<boolean>) {
    const initial = await startInitialization(await realpath(root), confirm);
    await this.open(root, initial); await prepareDirectories(root);
  }
  async close() {
    const old = this.#active; this.#active = undefined;
    try { await old?.close(); } finally { this.hide(); }
  }
}

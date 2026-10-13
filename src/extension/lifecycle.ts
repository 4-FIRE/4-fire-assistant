import { realpath } from "node:fs/promises";
import { requireThat } from "../common/validation.js";
import { authorizeMutation } from "../services/workspace-files.js";
import { Scope } from "../model/execution-intent.js";
import type { WorkspaceState } from "../model/workspace.js";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { InitializationService } from "../services/initialization-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { RecordService } from "../services/record-service.js";
import type { AgentService } from "../services/agent-service.js";
import { startInitialization } from "../services/initialization-service.js";
import { state } from "../storage/workspace-state.js";
import type { WorkspaceUpdateService } from "../services/workspace-update-service.js";
import type { Store } from "../storage/store.js";
import type { CallAccess } from "../tools/access.js";

export class WorkspaceInstance implements CallAccess {
  readonly #controller = new AbortController();
  #work = new AbortController();
  #background = new AbortController();
  #closing: Promise<void> | undefined;
  constructor(readonly root: string, private readonly store: Store, readonly providers: ProviderRegistry,
    readonly execution: ExecutionService, readonly initialization: InitializationService,
    readonly research: ResearchService, readonly records: RecordService, readonly agents: AgentService,
    readonly updates: WorkspaceUpdateService) {}
  check(ready = false) {
    requireThat(!this.#controller.signal.aborted, "ffa 未启用；请执行 /ffa init。");
    requireThat(!ready || this.initialization.snapshot().status === "ready", "请先完成工作区初始化。");
  }
  signal(signal?: AbortSignal, background = false) {
    this.check();
    return AbortSignal.any([this.#controller.signal, background ? this.#background.signal : this.#work.signal, ...(signal ? [signal] : [])]);
  }
  async authorizeFile(path: string, change: unknown, confirm: (value: unknown) => Promise<boolean>, signal: AbortSignal) {
    this.check();
    await authorizeMutation(this.root, path, change, confirm, signal);
    this.check();
  }
  scope(session: string) { this.check(); return new Scope(session); }
  cancelWork() { this.#work.abort(); this.#work = new AbortController(); }
  cancelAgents() { this.#background.abort(); this.#background = new AbortController(); this.agents.cancelAll(); }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#controller.abort(); this.#work.abort(); this.#background.abort();
    this.#closing = (async () => {
      try {
        await this.agents.close();
        const results = await Promise.allSettled([this.execution.close(), this.providers.close(), this.updates.close()]);
        const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "工作区关闭失败。");
      } finally { this.store.close(); }
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
    await this.open(root, initial);
  }
  async close() {
    const old = this.#active; this.#active = undefined;
    try { await old?.close(); } finally { this.hide(); }
  }
}

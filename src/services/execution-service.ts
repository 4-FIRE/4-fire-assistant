import { classify } from "./provider-registry.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { Ledger } from "./execution-ledger.js";
import { requireThat } from "../common/validation.js";
import type { Params } from "../common/json.js";
import type { Store } from "../storage/store.js";
import type { Intent, Scope } from "../model/execution-intent.js";
import { Receipt } from "../model/receipt.js";

/** Review leases are process- and request-local. The ledger never stores reusable authorization. */
export class ExecutionService {
  private readonly ledger: Ledger;
  #generation = 0;
  #busy = new Set<string>();
  #leases = new Map<string, { session: string; request: string; binding: string; generation: number }>();
  #prepared = new Map<string, number>();
  #healthy = true;
  constructor(private readonly providers: ProviderRegistry, private readonly store: Store) {
    this.ledger = new Ledger(store); this.ledger.recover();
  }
  get(id: string) { return this.ledger.get(id); }
  unsettled() { return this.ledger.unsettled(); }
  async call(scope: Scope, provider: string, operation: string, parameters: Params, confirm: (preview: unknown) => Promise<boolean> = async () => false, signal?: AbortSignal): Promise<Receipt> {
    const permission = this.providers.permission(provider, operation);
    requireThat(permission === "allow" || permission === "ask", "此工具需要独立复核或被禁止。请先查看权限。");
    const intent = await this.prepare(scope, "调用 " + provider + "/" + operation, provider, operation, parameters, signal, false);
    const result = await this.execute(intent.id, scope, confirm, signal);
    requireThat(result.state === "observed" && result.receiptId,
      result.state === "declined" ? "用户未批准，调用未发送。" : "调用结果不明，可能已经发送，不得自动重发。请用 ffa_record 查看 intent：" + result.id);
    return new Receipt(this.store.get<Receipt>("receipt", result.receiptId)!);
  }
  async prepare(scope: Scope, objective: string, provider: string, operation: string, parameters: Params, signal?: AbortSignal, deduplicate = true) {
    signal?.throwIfAborted(); parameters = structuredClone(parameters);
    requireThat(objective.trim(), "需要说明变更目标。");
    const permission = this.providers.permission(provider, operation), generation = this.#generation;
    requireThat(permission !== "deny", "工具被禁止。");
    this.providers.preview(provider, operation, parameters);
    const binding = await this.providers.binding(provider, operation, signal);
    signal?.throwIfAborted(); requireThat(generation === this.#generation, "准备期间约定或权限已变化，请重新准备。");
    const intent = this.ledger.prepare(scope, objective, provider, operation, parameters, binding, permission, deduplicate);
    if (intent.state === "prepared") this.#prepared.set(intent.id, generation);
    return intent;
  }
  async resolve(id: string, note: string, confirm: (value: unknown) => Promise<boolean>, signal?: AbortSignal) {
    requireThat(await confirm({ intent: { ...this.ledger.get(id) }, note }), "用户未确认结案。");
    signal?.throwIfAborted(); return this.ledger.resolve(id, note);
  }
  revoke() { this.#generation++; this.#leases.clear(); this.#prepared.clear(); }
  get generation() { return this.#generation; }
  review(id: string, scope: Scope, generation: number, expert: string, approved: boolean, evidenceIds: string[], note: string) {
    const intent = this.ledger.get(id);
    requireThat(this.providers.permission(intent.provider, intent.operation) === intent.permission, "工具权限已变化。");
    this.check(intent, scope, generation);
    requireThat(intent.state === "prepared" && this.#prepared.get(id) === generation, "当前方案不可复核；请在当前请求内重新准备。");
    const evidence = evidenceIds.map(id => this.store.get<Receipt>("receipt", id));
    requireThat(!approved || evidence.length > 0 && evidence.every(e => e?.success), "通过复核需要真实查询证据。");
    intent.review = { expert, approved, evidence: evidenceIds, note };
    this.ledger.save(intent, "reviewed"); this.#leases.delete(id);
    if (approved) this.#leases.set(id, { ...scope, binding: intent.binding, generation });
  }
  private check(intent: Intent, scope: Scope, generation: number) {
    requireThat(this.#healthy && this.store.healthy, "变更写入已禁用；请重启并核对状态。");
    requireThat(generation === this.#generation && intent.session === scope.session && intent.request === scope.request, "方案不属于当前有效请求，不能使用旧许可。");
  }
  async execute(id: string, scope: Scope, confirm: (preview: unknown) => Promise<boolean>, signal?: AbortSignal) {
    const intent = this.ledger.get(id);
    if (intent.state !== "prepared") return intent;
    const permission = this.providers.permission(intent.provider, intent.operation), generation = this.#generation;
    requireThat(permission === intent.permission, "工具权限已变化，请重新准备。");
    this.check(intent, scope, generation);
    requireThat(this.#prepared.get(id) === generation, "准备已失效，请重新准备。");
    requireThat(!this.#busy.has(id), "本方案正在确认或执行。"); this.#busy.add(id);
    try {
      const lease = this.#leases.get(id);
      requireThat(!intent.review || intent.review.approved, "已有复核拒绝此方案，请先处理复核结论。");
      if (permission === "review") {
        requireThat(lease && lease.session === scope.session && lease.request === scope.request && lease.generation === generation && lease.binding === intent.binding, "需要当前请求内的独立复核。");
      }
      requireThat(intent.binding === await this.providers.binding(intent.provider, intent.operation, signal), "能力提供方已变化，需重新准备与复核。");
      const operation = this.providers.operation(intent.provider, intent.operation);
      requireThat(this.providers.permission(intent.provider, intent.operation) === permission, "工具权限已变化。");
      this.check(intent, scope, generation); signal?.throwIfAborted();
      const allowed = permission === "allow" || await confirm({ intentId: id, objective: intent.objective,
        permission, invocation: this.providers.preview(intent.provider, intent.operation, intent.parameters), review: intent.review });
      requireThat(this.providers.permission(intent.provider, intent.operation) === permission, "确认期间工具权限已变化。");
      this.check(intent, scope, generation); signal?.throwIfAborted();
      if (!allowed) {
        this.#prepared.delete(id); intent.state = "declined";
        this.ledger.save(intent, "declined"); return intent;
      }
      let entered = false;
      try {
        const observation = await this.providers.send(intent.provider, intent.operation, intent.parameters, intent.binding, permission, () => {
          this.check(intent, scope, generation); signal?.throwIfAborted();
          requireThat(!entered, "单次发送许可已消费。");
          this.ledger.start(id); entered = true; this.#prepared.delete(id);
        }, signal);
        requireThat(entered, "发送入口未记录尝试。");
        try {
          const outcome = classify(observation, operation);
          const receipt = this.providers.receipt(intent.provider, intent.operation, intent.parameters, intent.binding,
            { ...observation, success: outcome === "accepted" });
          return this.ledger.observe(id, observation, outcome, receipt.id);
        }
        catch { this.#healthy = false; throw new Error("能力提供方回执未能可靠保存，禁止新变更。不得自动重发；请重启后核对。"); }
      } catch (error) {
        if (!this.#healthy) throw error;
        if (entered) {
          try { return this.ledger.unknown(id); }
          catch { this.#healthy = false; throw new Error("发送后状态保存失败，禁止新变更；请核对外部结果。"); }
        }
        if (!this.store.healthy) this.#healthy = false;
        throw error;
      }
    } finally { this.#leases.delete(id); this.#busy.delete(id); }
  }
}

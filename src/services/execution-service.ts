import { classify } from "./source-service.js";
import type { SourceService } from "./source-service.js";
import { Ledger } from "./execution-ledger.js";
import { requireThat } from "../common/validation.js";
import type { Params } from "../common/json.js";
import type { Store } from "../storage/store.js";
import type { Intent, Scope } from "../model/execution-intent.js";
import type { Receipt } from "../model/receipt.js";

/** Review leases are process- and request-local. The ledger never stores reusable authorization. */
export class ExecutionService {
  private readonly ledger: Ledger;
  #generation = 0;
  #busy = new Set<string>();
  #leases = new Map<string, { session: string; request: string; binding: string; generation: number }>();
  #prepared = new Map<string, number>();
  #healthy = true;
  constructor(private readonly sources: SourceService, private readonly store: Store) {
    this.ledger = new Ledger(store); this.ledger.recover();
  }
  get(id: string) { return this.ledger.get(id); }
  unsettled() { return this.ledger.unsettled(); }
  async prepare(scope: Scope, objective: string, source: string, operation: string, parameters: Params, signal?: AbortSignal) {
    signal?.throwIfAborted(); parameters = structuredClone(parameters);
    requireThat(objective.trim(), "需要说明变更目标。");
    const op = this.sources.operation(source, operation), generation = this.#generation;
    requireThat(op.effect === "change" && op.analysis, "操作不是已理解的变更。");
    this.sources.preview(source, operation, parameters);
    const binding = await this.sources.binding(source, operation, signal);
    signal?.throwIfAborted(); requireThat(generation === this.#generation, "准备期间约定已变化，请重新分析后准备。");
    const intent = this.ledger.prepare(scope, objective, source, operation, parameters, binding, op.analysis.execution);
    this.#prepared.set(intent.id, generation);
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
    this.check(intent, scope, generation);
    requireThat(intent.state === "prepared", "当前方案不可复核。");
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
    const intent = this.ledger.get(id), generation = this.#generation;
    this.check(intent, scope, generation);
    if (intent.state !== "prepared") return intent;
    requireThat(!this.#busy.has(id), "本方案正在确认或执行。"); this.#busy.add(id);
    try {
      const lease = this.#leases.get(id);
      requireThat(!intent.review || intent.review.approved, "已有复核拒绝此方案，请先处理复核结论。");
      const requirement = intent.execution;
      requireThat(requirement === "confirmation" || requirement === "independent", "执行意图缺少有效执行要求。");
      if (requirement === "independent") {
        requireThat(lease && lease.session === scope.session && lease.request === scope.request && lease.generation === generation && lease.binding === intent.binding, "需要当前请求内的独立复核。");
      } else requireThat(this.#prepared.get(id) === generation, "需要当前请求内重新准备，不能复用旧许可。");
      requireThat(intent.binding === await this.sources.binding(intent.source, intent.operation, signal), "来源已变化，需重新准备与复核。");
      const operation = this.sources.operation(intent.source, intent.operation);
      requireThat(operation.effect === "change" && operation.analysis?.execution === requirement, "执行要求已变化。");
      this.check(intent, scope, generation); signal?.throwIfAborted();
      const allowed = await confirm({ intentId: id, objective: intent.objective, analysis: operation.analysis,
        execution: requirement, invocation: this.sources.preview(intent.source, intent.operation, intent.parameters), review: intent.review });
      this.check(intent, scope, generation); signal?.throwIfAborted();
      if (!allowed) { intent.state = "declined"; this.ledger.save(intent, "declined"); return intent; }
      let entered = false;
      try {
        const observation = await this.sources.send(intent.source, intent.operation, intent.parameters, intent.binding, () => {
          this.check(intent, scope, generation); signal?.throwIfAborted();
          requireThat(!entered, "单次发送许可已消费。");
          this.ledger.start(id); entered = true;
        }, signal);
        requireThat(entered, "发送入口未记录尝试。");
        try { return this.ledger.observe(id, observation, classify(observation, operation)); }
        catch { this.#healthy = false; throw new Error("服务回执未能可靠保存，禁止新变更。不得自动重发；请重启后核对。"); }
      } catch (error) {
        if (!this.#healthy) throw error;
        if (entered) {
          try { return this.ledger.unknown(id); }
          catch { this.#healthy = false; throw new Error("发送后状态保存失败，禁止新变更；请核对外部结果。"); }
        }
        if (!this.store.healthy) this.#healthy = false;
        throw error;
      }
    } finally { this.#leases.delete(id); this.#prepared.delete(id); this.#busy.delete(id); }
  }
}

import { randomUUID } from "node:crypto";
import { classify, type Sources, type Receipt, type Observation } from "./sources.js";
import { requireThat, canonical, json, type Params } from "./values.js";
import type { Store } from "./storage.js";

export interface Intent {
  id: string; session: string; request: string; objective: string; source: string; operation: string; parameters: Params;
  binding: string; createdAt: string; state: "prepared" | "dispatched" | "observed" | "unknown" | "closed" | "declined";
  attempt?: { id: string; at: string }; observation?: Observation; outcome?: "accepted" | "rejected" | "unknown";
  review?: { expert: string; approved: boolean; evidence: string[]; note: string }; resolution?: string;
}
export interface Scope { session: string; request: string }
export class Ledger {
  constructor(readonly store: Store) {}
  list() { return this.store.list<Intent>("intent"); }
  get(id: string) { const intent = this.store.get<Intent>("intent", id); requireThat(intent, "交易意图不存在。"); return intent; }
  unsettled() { return this.list().filter(intent => intent.state === "dispatched" || intent.state === "unknown"); }
  save(intent: Intent, event: string) {
    this.store.transaction(() => { this.store.put("intent", intent.id, intent); this.store.audit(event, json(intent)); });
  }
  recover() {
    for (const intent of this.list()) if (intent.state === "dispatched") { intent.state = "unknown"; this.save(intent, "recovered_unknown"); }
  }
  prepare(scope: Scope, objective: string, source: string, operation: string, parameters: Params, binding: string) {
    canonical(parameters);
    const found = this.list().findLast(i => i.session === scope.session && i.request === scope.request &&
      i.source === source && i.operation === operation && canonical(i.parameters) === canonical(parameters));
    if (found) {
      if (found.state !== "prepared" || found.binding === binding) return found;
      found.state = "declined"; this.save(found, "binding_changed");
    }
    requireThat(!this.unsettled().length, "有结果不明的交易；请先核对，不得用新参数绕过。");
    const intent: Intent = { id: randomUUID(), ...scope, objective, source, operation, parameters: structuredClone(parameters),
      binding, createdAt: new Date().toISOString(), state: "prepared" };
    this.save(intent, "prepared"); return intent;
  }
  start(id: string) {
    return this.store.transaction(() => {
      const intent = this.get(id);
      requireThat(intent.state === "prepared" && !intent.attempt, "该意图已处理，不能重复发送。");
      requireThat(!this.unsettled().length, "工作区有待核对交易。");
      intent.state = "dispatched"; intent.attempt = { id: randomUUID(), at: new Date().toISOString() };
      this.store.put("intent", id, intent); this.store.audit("dispatch_started", json(intent)); return intent;
    });
  }
  observe(id: string, observation: Observation, outcome: Intent["outcome"]) {
    const intent = this.get(id);
    requireThat(intent.state === "dispatched" && !intent.observation && intent.attempt, "不能覆盖已有执行回执。");
    intent.observation = observation; intent.outcome = outcome ?? "unknown";
    intent.state = outcome === "accepted" || outcome === "rejected" ? "observed" : "unknown";
    this.save(intent, "observed"); return intent;
  }
  unknown(id: string) {
    const intent = this.get(id); requireThat(intent.state === "dispatched", "发送状态不符。");
    intent.state = "unknown"; this.save(intent, "unknown"); return intent;
  }
  resolve(id: string, note: string) {
    requireThat(note.trim().length > 0 && note.length <= 4000, "需要具体核对依据（1–4000 字符）。");
    const intent = this.get(id); requireThat(intent.state === "unknown", "只能人工结案结果不明的交易。");
    intent.state = "closed"; intent.resolution = note; this.save(intent, "resolved"); return intent;
  }
}

/** Review leases are process- and request-local. The ledger never stores reusable authorization. */
export class Trading {
  readonly ledger: Ledger;
  #generation = 0;
  #busy = new Set<string>();
  #leases = new Map<string, { session: string; request: string; binding: string; generation: number }>();
  #healthy = true;
  constructor(readonly sources: Sources) { this.ledger = new Ledger(sources.store); this.ledger.recover(); }
  revoke() { this.#generation++; this.#leases.clear(); }
  get generation() { return this.#generation; }
  review(id: string, scope: Scope, generation: number, expert: string, approved: boolean, evidenceIds: string[], note: string) {
    const intent = this.ledger.get(id);
    this.check(intent, scope, generation);
    requireThat(intent.state === "prepared", "当前方案不可复核。");
    const evidence = evidenceIds.map(id => this.sources.store.get<Receipt>("receipt", id));
    requireThat(!approved || evidence.length > 0 && evidence.every(e => e?.success), "通过复核需要真实查询证据。");
    intent.review = { expert, approved, evidence: evidenceIds, note };
    this.ledger.save(intent, "reviewed"); this.#leases.delete(id);
    if (approved) this.#leases.set(id, { ...scope, binding: intent.binding, generation });
  }
  private check(intent: Intent, scope: Scope, generation: number) {
    requireThat(this.#healthy && this.sources.store.healthy, "交易写入已禁用；请重启并核对状态。");
    requireThat(generation === this.#generation && intent.session === scope.session && intent.request === scope.request, "方案不属于当前有效请求，不能使用旧许可。");
  }
  async execute(id: string, scope: Scope, confirm: (preview: unknown) => Promise<boolean>, signal?: AbortSignal) {
    const intent = this.ledger.get(id), generation = this.#generation;
    this.check(intent, scope, generation);
    if (intent.state !== "prepared") return intent;
    requireThat(!this.#busy.has(id), "本方案正在确认或执行。"); this.#busy.add(id);
    try {
      const lease = this.#leases.get(id);
      requireThat(lease && lease.session === scope.session && lease.request === scope.request && lease.generation === generation && lease.binding === intent.binding, "需要当前请求内的独立复核。");
      requireThat(intent.binding === await this.sources.binding(intent.source, intent.operation), "来源已变化，需重新准备与复核。");
      signal?.throwIfAborted();
      const allowed = await confirm({ intentId: id, objective: intent.objective, invocation: this.sources.preview(intent.source, intent.operation, intent.parameters), review: intent.review });
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
        try { return this.ledger.observe(id, observation, classify(observation, this.sources.operation(intent.source, intent.operation))); }
        catch { this.#healthy = false; throw new Error("服务回执未能可靠保存，禁止新交易。不得自动重发；请重启后核对。"); }
      } catch (error) {
        if (!this.#healthy) throw error;
        if (entered) {
          try { return this.ledger.unknown(id); }
          catch { this.#healthy = false; throw new Error("发送后状态保存失败，禁止新交易；请核对外部结果。"); }
        }
        if (!this.sources.store.healthy) this.#healthy = false;
        throw error;
      }
    } finally { this.#leases.delete(id); this.#busy.delete(id); }
  }
}

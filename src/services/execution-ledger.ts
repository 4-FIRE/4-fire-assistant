import { randomUUID } from "node:crypto";
import { requireThat } from "../common/validation.js";
import { canonical, json, type Params } from "../common/json.js";
import { Intent } from "../model/execution-intent.js";
import type { Scope } from "../model/execution-intent.js";
import type { Observation } from "../model/receipt.js";
import type { Store } from "../storage/store.js";

export class Ledger {
  constructor(private readonly store: Store) {}
  list() { return this.store.list<Intent>("intent").map(value => new Intent(value)); }
  get(id: string) { const intent = this.store.get<Intent>("intent", id); requireThat(intent, "变更意图不存在。"); return new Intent(intent); }
  unsettled() { return this.list().filter(intent => intent.state === "dispatched" || intent.state === "unknown"); }
  save(intent: Intent, event: string) {
    this.store.transaction(() => { this.store.put("intent", intent.id, { ...intent }); this.store.audit(event, json({ ...intent })); });
  }
  recover() {
    for (const intent of this.list()) if (intent.state === "dispatched") { intent.state = "unknown"; this.save(intent, "recovered_unknown"); }
  }
  prepare(scope: Scope, objective: string, source: string, operation: string, parameters: Params, binding: string, execution: "confirmation" | "independent") {
    requireThat(execution === "confirmation" || execution === "independent", "必须明确指定执行要求。");
    canonical(parameters);
    const found = this.list().findLast(i => i.session === scope.session && i.request === scope.request &&
      i.source === source && i.operation === operation && canonical(i.parameters) === canonical(parameters));
    if (found) {
      if (found.state !== "prepared" || found.binding === binding) return found;
      found.state = "declined"; this.save(found, "binding_changed");
    }
    requireThat(!this.unsettled().length, "有结果不明的变更；请先核对，不得用新参数绕过。");
    const intent = new Intent({ id: randomUUID(), ...scope, objective, source, operation, parameters: structuredClone(parameters),
      binding, execution, createdAt: new Date().toISOString(), state: "prepared" });
    this.save(intent, "prepared"); return intent;
  }
  start(id: string) {
    return this.store.transaction(() => {
      const intent = this.get(id);
      requireThat(intent.state === "prepared" && !intent.attempt, "该意图已处理，不能重复发送。");
      requireThat(!this.unsettled().length, "工作区有待核对变更。");
      intent.state = "dispatched"; intent.attempt = { id: randomUUID(), at: new Date().toISOString() };
      this.store.put("intent", id, { ...intent }); this.store.audit("dispatch_started", json({ ...intent })); return intent;
    });
  }
  observe(id: string, observation: Observation, outcome: Intent["outcome"]) {
    const intent = this.get(id);
    requireThat(intent.state === "dispatched" && !intent.observation && intent.attempt, "不能覆盖已有执行回执。");
    intent.observation = { ...observation }; intent.outcome = outcome ?? "unknown";
    intent.state = outcome === "accepted" || outcome === "rejected" ? "observed" : "unknown";
    this.save(intent, "observed"); return intent;
  }
  unknown(id: string) {
    const intent = this.get(id); requireThat(intent.state === "dispatched", "发送状态不符。");
    intent.state = "unknown"; this.save(intent, "unknown"); return intent;
  }
  resolve(id: string, note: string) {
    requireThat(note.trim().length > 0 && note.length <= 4000, "需要具体核对依据（1–4000 字符）。");
    const intent = this.get(id); requireThat(intent.state === "unknown", "只能人工结案结果不明的变更。");
    intent.state = "closed"; intent.resolution = note; this.save(intent, "resolved"); return intent;
  }
}

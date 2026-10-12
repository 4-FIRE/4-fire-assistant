import { randomUUID } from "node:crypto";
import { requireThat } from "../common/validation.js";
import { canonical, json, type Params } from "../common/json.js";
import { Intent } from "../model/execution-intent.js";
import type { Scope } from "../model/execution-intent.js";
import type { Observation, Receipt } from "../model/receipt.js";
import type { Permission } from "../model/permission.js";
import type { Store } from "../storage/store.js";

export class Ledger {
  constructor(private readonly store: Store) {}
  list() { return this.store.list<Intent>("intent").map(value => new Intent(value)); }
  get(id: string) { const intent = this.store.get<Intent>("intent", id); requireThat(intent, "调用记录不存在。"); return new Intent(intent); }
  unsettled() { return this.list().filter(intent => intent.state === "dispatched" || intent.state === "unknown"); }
  save(intent: Intent, event: string) {
    this.store.transaction(() => { this.store.put("intent", intent.id, { ...intent }); this.store.audit(event, json({ ...intent })); });
  }
  recover() {
    for (const intent of this.list()) {
      if (intent.state === "dispatched") { intent.state = "unknown"; this.save(intent, "recovered_unknown"); }
      else if (intent.state === "pending") { intent.state = "declined"; this.save(intent, "interrupted_before_send"); }
    }
  }
  create(scope: Scope, provider: string, operation: string, parameters: Params, binding: string, permission: Exclude<Permission, "deny">) {
    canonical(parameters);
    const intent = new Intent({ id: randomUUID(), session: scope.session, provider, operation, parameters: structuredClone(parameters),
      binding, permission, createdAt: new Date().toISOString(), state: "pending" });
    this.save(intent, "call_created"); return intent;
  }
  decline(id: string) {
    const intent = this.get(id); requireThat(intent.state === "pending", "调用已处理。");
    intent.state = "declined"; this.save(intent, "declined"); return intent;
  }
  start(id: string) {
    return this.store.transaction(() => {
      const intent = this.get(id);
      requireThat(intent.state === "pending" && !intent.attempt, "此调用已处理，不能重复发送。");
      intent.state = "dispatched"; intent.attempt = { id: randomUUID(), at: new Date().toISOString() };
      this.store.put("intent", id, { ...intent }); this.store.audit("dispatch_started", json({ ...intent })); return intent;
    });
  }
  observe(id: string, observation: Observation, outcome: NonNullable<Intent["outcome"]>, receipt: Receipt) {
    const intent = this.get(id);
    requireThat(intent.state === "dispatched" && !intent.observation && intent.attempt, "不能覆盖已有执行回执。");
    intent.observation = { ...observation }; intent.outcome = outcome; intent.receiptId = receipt.id;
    intent.state = outcome === "unknown" ? "unknown" : "observed";
    this.store.transaction(() => {
      this.store.put("receipt", receipt.id, { ...receipt });
      this.store.put("intent", id, { ...intent }); this.store.audit("observed", json({ ...intent }));
    });
    return intent;
  }
  unknown(id: string) {
    const intent = this.get(id); requireThat(intent.state === "dispatched", "发送状态不符。");
    intent.state = "unknown"; this.save(intent, "unknown"); return intent;
  }
  resolve(id: string, note: string) {
    requireThat(note.trim().length > 0 && note.length <= 4000, "需要具体核对依据（1–4000 字符）。");
    const intent = this.get(id); requireThat(intent.state === "unknown", "只能人工结案结果不明的调用。");
    intent.state = "closed"; intent.resolution = note; this.save(intent, "resolved"); return intent;
  }
}

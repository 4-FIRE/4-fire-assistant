import { randomUUID } from "node:crypto";
import { requireThat } from "../../common/validation.js";
import { canonical, type Params } from "../../common/json.js";
import { Intent } from "../../model/execution-intent.js";
import type { Scope } from "../../model/execution-intent.js";
import type { Observation, Receipt } from "../../model/receipt.js";
import type { Permission } from "../../model/permission.js";
import type { CallFiles } from "../../storage/call-files.js";
import { callState, type CallRecord } from "../../storage/call-record.js";
import { callResult, type CallResult } from "../../storage/call-result.js";

export class Ledger {
  constructor(private readonly calls: CallFiles) {}
  list() { return this.calls.list().map(record => new Intent(record.intent)); }
  get(id: string) { const record = this.calls.get(id); requireThat(record, "调用记录不存在。"); return new Intent(record.intent); }
  unknownCalls() { return this.list().filter(intent => intent.state === "dispatched" || intent.state === "unknown"); }
  save(intent: Intent, event: string, receipt?: CallRecord["receipt"], result?: CallResult) {
    const previous = this.calls.get(intent.id), savedReceipt = receipt ?? previous?.receipt;
    this.calls.save({ intent: { ...intent }, ...(savedReceipt ? { receipt: { ...savedReceipt } } : {}),
      events: [...(previous?.events ?? []), { id: randomUUID(), event, at: new Date().toISOString(), data: callState(intent) }] }, result);
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
    const intent = this.get(id);
    requireThat(intent.state === "pending" && !intent.attempt, "此调用已处理，不能重复发送。");
    intent.state = "dispatched"; intent.attempt = { id: randomUUID(), at: new Date().toISOString() };
    this.save(intent, "dispatch_started"); return intent;
  }
  observe(id: string, observation: Observation, outcome: NonNullable<Intent["outcome"]>, receipt: Pick<Receipt, "id" | "at" | "success">) {
    const intent = this.get(id);
    requireThat(intent.state === "dispatched" && !intent.observation && intent.attempt, "不能覆盖已有执行回执。");
    intent.observation = { success: observation.success }; intent.outcome = outcome; intent.receiptId = receipt.id;
    intent.state = outcome === "unknown" ? "unknown" : "observed";
    const { id: receiptId, at, success } = receipt;
    this.save(intent, "observed", { id: receiptId, at, success }, callResult(observation));
    return intent;
  }
  unknown(id: string) {
    const intent = this.get(id); requireThat(intent.state === "dispatched", "发送状态不符。");
    intent.state = "unknown"; this.save(intent, "unknown"); return intent;
  }
}

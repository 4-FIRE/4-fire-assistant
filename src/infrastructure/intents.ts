import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { IntentAudit, IntentStore } from "../application/execution.js";
import type { ExecutionIntent } from "../domain/execution.js";
import { canonical } from "../domain/shared.js";
import { IntentDoc, IntentIndexDoc, json } from "./business-documents.js";

/** Index, aggregate and audit share one Durable commit, independent of cancelled agent context. */
export class DurableIntentStore implements IntentStore {
  constructor(private readonly harness: Harness) {}
  async read(id: string): Promise<ExecutionIntent | undefined> {
    const doc = await this.harness.snapshot(IntentDoc, id, BACKGROUND_CONTEXT);
    return doc ? json(doc.value) as unknown as ExecutionIntent : undefined;
  }
  async list(): Promise<ExecutionIntent[]> {
    const index = await this.harness.snapshot(IntentIndexDoc, BACKGROUND_CONTEXT);
    const values: ExecutionIntent[] = [];
    for (const id of index?.ids ?? []) {
      const intent = await this.read(id);
      if (!intent) throw new Error("Intent index is inconsistent");
      values.push(intent);
    }
    return values;
  }
  async commit<T>(mutate: (intents: ExecutionIntent[]) => { result: T; audit: IntentAudit[] }): Promise<T> {
    return this.harness.commit(async tx => {
      const index = await tx.doc(IntentIndexDoc), intents: ExecutionIntent[] = [], original = new Map<string, string>();
      for (const id of index.ids) {
        const record = await tx.doc(IntentDoc, id, null);
        // Chord transaction documents are proxies, not structured-cloneable values.
        const intent = json(record.value) as unknown as ExecutionIntent;
        intents.push(intent); original.set(id, canonical(record.value));
      }
      const change = mutate(intents);
      for (const intent of intents) {
        const value = json(intent);
        if (original.get(intent.intentId) !== canonical(value)) {
          const doc = await tx.doc(IntentDoc, intent.intentId, value); doc.value = value;
        }
        if (!index.ids.includes(intent.intentId)) index.ids.push(intent.intentId);
      }
      for (const event of change.audit) await tx.appendEntry(event.ownerId as ConversationId, { kind: "fire.intent-audit", data: json(event) });
      return change.result as T;
    }, BACKGROUND_CONTEXT);
  }
}

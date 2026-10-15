import { canonical } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";
import type { Intent } from "../model/execution-intent.js";
import type { Receipt } from "../model/receipt.js";

export type CallState = Pick<Intent, "state" | "attempt" | "observation" | "receiptId" | "outcome">;
export interface CallEvent { id: string; event: string; at: string; data: CallState }
export interface CallRecord {
  intent: Intent;
  receipt?: Pick<Receipt, "id" | "at" | "success">;
  events: CallEvent[];
}

const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
const text = { type: "string", minLength: 1 };
const at = { type: "string", format: "date-time" };
const stateProperties = {
  state: { enum: ["pending", "declined", "dispatched", "observed", "unknown"] }, receiptId: id,
  attempt: { type: "object", additionalProperties: false, required: ["id", "at"], properties: { id, at } },
  observation: { type: "object", additionalProperties: false, required: ["success"], properties: { success: { type: "boolean" } } },
  outcome: { enum: ["accepted", "rejected", "unknown"] },
};
const stateSchema = { type: "object", additionalProperties: false, required: ["state"], properties: stateProperties };
const intentSchema = { type: "object", additionalProperties: false,
  required: ["id", "session", "provider", "operation", "parameters", "binding", "createdAt", "permission", "state"],
  properties: {
    id, session: text, provider: { type: "string", pattern: "^[a-z][a-z0-9_]{0,47}$" }, operation: text,
    parameters: { type: "object" }, binding: text, createdAt: at, permission: { enum: ["allow", "ask", "review"] },
    ...stateProperties,
  },
};
const validRecord = schema({ type: "object", additionalProperties: false, required: ["intent", "events"], properties: {
  intent: intentSchema,
  receipt: { type: "object", additionalProperties: false, required: ["id", "at", "success"],
    properties: { id, at, success: { type: "boolean" } } },
  events: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
    required: ["id", "event", "at", "data"], properties: { id, event: text, at, data: stateSchema } } },
} });

export function callState(intent: CallState): CallState {
  const { state, attempt, observation, receiptId, outcome } = intent;
  return { state, ...(attempt ? { attempt } : {}), ...(observation ? { observation } : {}),
    ...(receiptId ? { receiptId } : {}), ...(outcome ? { outcome } : {}) };
}
function checkState(intent: CallState) {
  const sent = !["pending", "declined"].includes(intent.state);
  requireThat(sent === !!intent.attempt, "调用状态与发送尝试不一致。");
  requireThat(!!intent.observation === !!intent.receiptId && !!intent.observation === !!intent.outcome,
    "观察结果、回执引用与结果分类必须一起保存。");
  requireThat(!intent.observation || sent && intent.state !== "dispatched", "调用状态与观察结果不一致。");
  requireThat(intent.state !== "observed" || intent.observation && intent.outcome !== "unknown", "已观察调用缺少明确结果。");
  requireThat(intent.state !== "unknown" || !intent.outcome || intent.outcome === "unknown", "结果不明调用不能带有明确结果。");
}

/** Metadata only. Result bodies are immutable files and are never loaded by this validator. */
export function parseCallRecord(value: unknown): CallRecord {
  requireThat(validRecord(value), "调用账本结构无效。");
  canonical(value);
  const record = value as CallRecord, { intent, receipt, events } = record;
  checkState(intent);
  requireThat(intent.receiptId === receipt?.id, "调用回执引用不一致。");
  const ids = new Set<string>();
  for (const event of events) {
    requireThat(!ids.has(event.id), "审计事件 ID 重复。"); ids.add(event.id);
    checkState(event.data);
    if (event.data.attempt) requireThat(canonical(event.data.attempt) === canonical(intent.attempt), "审计发送尝试不一致。");
    if (event.data.observation) for (const key of ["observation", "outcome", "receiptId"] as const) {
      requireThat(canonical(event.data[key]) === canonical(intent[key]), "审计观察结果不一致。");
    }
  }
  requireThat(canonical(events.at(-1)!.data) === canonical(callState(intent)), "最新审计快照与调用状态不一致。");
  return record;
}

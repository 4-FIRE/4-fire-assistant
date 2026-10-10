import { defineDoc, defineDocFamily, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import type { WorkSummary } from "../application/ports.js";
import type { Json, Role } from "../domain/shared.js";

export type StoredRequest = { requestId: string; status: WorkSummary["status"]; content: string; submissionId: SubmissionId | null };
export const WorkDoc = defineDoc<{ request: StoredRequest | null }>({
  kind: "fire.work", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ request: null }),
});
export type ExpertRecord = { expertId: string; role: Role; conversationId: ConversationId; purpose: string; reportRefs: string[]; active: string | null };
export type Delegation = {
  key: string; expertId: string; conversationId: ConversationId; ownerId: ConversationId;
  ownerRequestId: string; role: Role; goal: string; requestId: string; roundId: string;
  submissionId: SubmissionId | null; reportRef: string | null;
};
export const TeamDoc = defineDoc<{ experts: ExpertRecord[]; delegations: Delegation[] }>({
  kind: "fire.team", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ experts: [], delegations: [] }),
});
export const ExpertDoc = defineDoc<{ role: Role; ownerId: ConversationId | null; roundId: string | null; requestId: string | null; allowedRefs: string[] }>({
  kind: "fire.expert", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ role: "coordinator", ownerId: null, roundId: null, requestId: null, allowedRefs: [] }),
});
export const RoundDoc = defineDocFamily<{ scope: Json; evidenceRefs: string[]; decision: Json; intentId: string | null }, Json>({
  kind: "fire.review-round", version: 1, family: true, scope: "conversation", history: "latest", fork: "initial",
  initial: seed => ({ scope: seed, evidenceRefs: [], decision: null, intentId: null }),
});
export const ArtifactDoc = defineDocFamily<{ value: Json }, Json>({
  kind: "fire.report", version: 1, family: true, scope: "conversation", history: "latest", fork: "initial",
  initial: value => ({ value }),
});
export const IntentIndexDoc = defineDoc<{ ids: string[] }>({
  kind: "fire.intent-index", version: 1, scope: "session", initial: () => ({ ids: [] }),
});
export const IntentDoc = defineDocFamily<{ value: Json }, Json>({
  kind: "fire.execution-intent", version: 1, family: true, scope: "session", initial: value => ({ value }),
});
/** Serialization is confined to this boundary; permits and SDK handles never pass it. */
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }

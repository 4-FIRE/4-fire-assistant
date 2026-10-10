import { sameBinding, sameOperation, type Evidence, type Json, type OperationSpec, type Scope, type ServiceBinding } from "./shared.js";

/** Business checks belong to the independent reviewer, not the execution gate. */
export type ReviewDecision = { action: "APPROVE" | "REJECT"; operation: OperationSpec };
export function reviewErrors(input: { decision: ReviewDecision; operation: OperationSpec }): string[] {
  const errors: string[] = [];
  if (!["APPROVE", "REJECT"].includes(input.decision.action)) errors.push("invalid_review_action");
  if (!sameOperation(input.decision.operation, input.operation)) errors.push("exact_parameters_mismatch");
  return errors;
}

export type IntentState = "Proposed" | "DispatchStarted" | "Observed" | "Unknown" | "Reconciled" | "ProvenNotSent" | "Abandoned";
export type WriteObservation = { observedAt: string; success: boolean; raw: Json; data: Json; outcome?: "accepted" | "rejected" | "unknown" };
export type ExecutionIntent = {
  intentId: string;
  ownerId: number;
  ownerRequestId: string;
  preparedBy: number;
  objectiveRef: string;
  revision: number;
  operation: OperationSpec;
  operationDigest: string;
  binding: ServiceBinding;
  state: IntentState;
  preparationEvidence: Evidence[];
  review: { revision: number; roundId: string; decision: Json; evidence: Evidence[] } | null;
  attempt: { attemptId: string; startedAt: string; sourceRef: string } | null;
  observation: WriteObservation | null;
  reconciliation: { obtainedAt: string; established: boolean; evidenceRefs: string[]; data: Json } | null;
};
export type AuthorizationGrant = {
  processEpoch: string;
  intentId: string;
  revision: number;
  binding: ServiceBinding;
  operationDigest: string;
  ownerId: number;
  requestId: string;
};
export type ApprovalLease = AuthorizationGrant & { expertId: string; roundId: string; evidenceRefs: string[] };
export class ExecutionViolation extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ExecutionViolation"; }
}
export function owned(intent: ExecutionIntent, scope: Scope, currentRequest = true): void {
  if (intent.ownerId !== scope.ownerId || currentRequest && intent.ownerRequestId !== scope.requestId) {
    throw new ExecutionViolation("INTENT_SCOPE_DENIED", "执行意图不属于当前会话/请求。");
  }
}
export function grantMatches(grant: AuthorizationGrant, intent: ExecutionIntent, scope: Scope, processEpoch: string, binding: ServiceBinding): boolean {
  return grant.processEpoch === processEpoch && grant.intentId === intent.intentId && grant.revision === intent.revision &&
    grant.ownerId === scope.ownerId && grant.requestId === scope.requestId && grant.operationDigest === intent.operationDigest &&
    sameBinding(grant.binding, intent.binding) && sameBinding(binding, intent.binding);
}
export function unresolved(intent: ExecutionIntent): boolean {
  return intent.state === "DispatchStarted" || intent.state === "Unknown";
}
export function startAttempt(intent: ExecutionIntent, attempt: NonNullable<ExecutionIntent["attempt"]>): void {
  if (intent.state !== "Proposed" || intent.attempt) throw new ExecutionViolation("ALREADY_ATTEMPTED", "本意图不能再次进入发送边界。");
  intent.attempt = attempt; intent.state = "DispatchStarted";
}
export function observe(intent: ExecutionIntent, observation: WriteObservation): void {
  if (!intent.attempt || !["DispatchStarted", "Unknown"].includes(intent.state) || intent.observation) {
    throw new ExecutionViolation("OBSERVATION_CONFLICT", "观测不匹配原尝试；不能覆盖已有回执。");
  }
  intent.observation = observation; intent.state = observation.outcome === "accepted" || observation.outcome === "rejected" ? "Observed" : "Unknown";
}
export function markUnknown(intent: ExecutionIntent): void {
  if (!intent.attempt || intent.observation || !["DispatchStarted", "Unknown"].includes(intent.state)) throw new ExecutionViolation("UNKNOWN_CONFLICT", "不能抹去已观测回执或虚构发送尝试。");
  intent.state = "Unknown";
}
export function resolveUnknown(intent: ExecutionIntent, obtainedAt: string, note: string): void {
  if (!intent.attempt || intent.state !== "Unknown" || !note.trim()) throw new ExecutionViolation("RESOLUTION_INVALID", "只能对未知尝试记录人工核对结论。");
  intent.reconciliation = { obtainedAt, established: true, evidenceRefs: [], data: { source: "terminal", note } };
  intent.state = "Reconciled";
}
export function reprepare(intent: ExecutionIntent, operation: OperationSpec, binding: ServiceBinding, digest: string): void {
  if (intent.state !== "Proposed" || intent.attempt) throw new ExecutionViolation("PREPARATION_CLOSED", "已经尝试或放弃的意图不可修改成新操作。");
  if (sameOperation(intent.operation, operation) && sameBinding(intent.binding, binding)) return;
  intent.revision++; intent.operation = structuredClone(operation); intent.binding = structuredClone(binding); intent.operationDigest = digest; intent.review = null;
}
export function duplicate(a: ExecutionIntent, scope: Scope, operation: OperationSpec, binding: ServiceBinding): boolean {
  return a.ownerId === scope.ownerId && a.ownerRequestId === scope.requestId &&
    a.binding.connectionId === binding.connectionId && sameOperation(a.operation, operation);
}

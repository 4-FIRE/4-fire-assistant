import { requireCapability, builtInPermissions, type RolePermissions } from "./permissions.js";
import { AssistantError } from "./ports.js";
import type { DispatchPermit, NativeObservation, ToolPort } from "./business-ports.js";
import {
  ExecutionViolation, duplicate, grantMatches, markUnknown, observe, owned, resolveUnknown, reprepare, reviewErrors, startAttempt, unresolved,
  type ApprovalLease, type AuthorizationGrant, type ExecutionIntent, type ReviewDecision,
} from "../domain/execution.js";
import { sameBinding, sameOperation, type Evidence, type Json, type OperationSpec, type Scope, type ServiceBinding } from "../domain/shared.js";

export interface IntentAudit { ownerId: number; intentId: string; kind: string; data: Json }
export interface IntentStore {
  read(id: string): Promise<ExecutionIntent | undefined>;
  list(): Promise<ExecutionIntent[]>;
  commit<T>(mutate: (intents: ExecutionIntent[]) => { result: T; audit: IntentAudit[] }): Promise<T>;
}
export interface Confirmation {
  intentId: string; revision: number; operation: OperationSpec; binding: ServiceBinding;
  description: string;
}
export interface ApprovalInteraction {
  confirm(confirmation: Confirmation, signal?: AbortSignal): Promise<boolean>;
  revoke(): void;
}
export interface ExecutionEnvironment {
  processEpoch: string;
  id(): string;
  now(): string;
  hash(value: Json): string;
  isLive(scope: Scope): boolean;
  emergency(message: string): void;
}
export interface ReviewChallenge { intent: ExecutionIntent; roundId: string; scope: Scope }
function serializable(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
function audit(intent: ExecutionIntent, kind: string, data: unknown = {}): IntentAudit {
  return { ownerId: intent.ownerId, intentId: intent.intentId, kind, data: serializable(data) };
}

/** All financial/strategy writes use this service; permissions are strictly process-local. */
export class ExecutionService {
  readonly #authorizations = new Map<string, AuthorizationGrant>();
  readonly #approvals = new Map<string, ApprovalLease>();
  readonly #rounds = new Map<string, ReviewChallenge>();
  readonly #denied = new Set<string>();
  readonly #locks = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #poisoned = false;
  readonly #uncommitted = new Map<string, NativeObservation>();
  constructor(private readonly store: IntentStore, private readonly trading: ToolPort,
    private readonly interaction: ApprovalInteraction, private readonly env: ExecutionEnvironment, private readonly roles: RolePermissions = builtInPermissions) {}

  private guard(scope: Scope): void {
    if (this.#poisoned) throw new AssistantError("EXECUTION_STORAGE_FAILED", "写入路径已关闭；先重开检查记录与真实状态。");
    if (!this.env.isLive(scope)) throw new AssistantError("REQUEST_INACTIVE", "当前请求已停止，不能开始新的查询或写入。");
  }
  private allowed(operation: OperationSpec, scope: Scope): void {
    requireCapability(scope.role, "prepare", this.roles);
    if (this.trading.allowed && !this.trading.allowed(operation.name, scope.role)) throw new AssistantError("ROLE_DENIED", "当前角色没有该来源操作的授权。");
    if (this.trading.kind(operation.name) !== "write") throw new AssistantError("OPERATION_DENIED", "操作未配置为写入。");
    this.trading.validate(operation);
  }
  private fingerprint(operation: OperationSpec): string { return this.env.hash({ name: operation.name, parameters: operation.parameters }); }
  private grant(intent: ExecutionIntent, scope: Scope): AuthorizationGrant {
    return { processEpoch: this.env.processEpoch, intentId: intent.intentId, revision: intent.revision,
      binding: structuredClone(intent.binding), operationDigest: intent.operationDigest, ownerId: scope.ownerId, requestId: scope.requestId };
  }
  private newIntent(scope: Scope, operation: OperationSpec, binding: ServiceBinding, objectiveRef: string): ExecutionIntent {
    return { intentId: this.env.id(), ownerId: scope.ownerId, ownerRequestId: scope.requestId, preparedBy: scope.conversationId,
      objectiveRef, revision: 1, operation: structuredClone(operation), operationDigest: this.fingerprint(operation),
      binding: structuredClone(binding), state: "Proposed", preparationEvidence: [], review: null, attempt: null, observation: null, reconciliation: null };
  }
  async prepare(scope: Scope, operation: OperationSpec, objectiveRef: string, evidence: Evidence[] = []): Promise<ExecutionIntent> {
    this.guard(scope);
    await this.trading.refresh(); this.guard(scope); this.allowed(operation, scope);
    const binding = this.trading.binding(operation.name);
    const currentEvidence = evidence.filter(e => e.success && e.scope.ownerId === scope.ownerId && e.scope.requestId === scope.requestId &&
      e.binding?.connectionId === binding.connectionId && e.binding.epoch === binding.epoch && e.binding.accessDigest === binding.accessDigest);
    const result = await this.store.commit(intents => {
      const exact = intents.find(i => duplicate(i, scope, operation, binding));
      if (exact) {
        const before = structuredClone(exact);
        if (exact.state === "Proposed") {
          reprepare(exact, operation, binding, this.fingerprint(operation));
          if (before.revision !== exact.revision) exact.preparationEvidence = structuredClone(currentEvidence);
        }
        return { result: structuredClone(exact), audit: before.revision === exact.revision ? [] : [audit(exact, "reprepared", { previous: before, current: exact })] };
      }
      // Unknown impact cannot be safely separated across credentials/URLs without an account identity contract.
      if (intents.some(i => unresolved(i))) throw new AssistantError("UNRESOLVED_OBLIGATION", "已有未解决发送义务；先核对，不能以新请求/连接/参数绕过。");
      const previous = intents.find(i => i.ownerId === scope.ownerId && i.ownerRequestId === scope.requestId &&
        i.objectiveRef === objectiveRef && i.operation.name === operation.name && i.state === "Proposed" && !i.attempt);
      if (previous) {
        const before = structuredClone(previous); reprepare(previous, operation, binding, this.fingerprint(operation)); previous.review = null; previous.preparationEvidence = structuredClone(currentEvidence);
        return { result: structuredClone(previous), audit: [audit(previous, "reprepared", { previous: before, current: previous })] };
      }
      const intent = this.newIntent(scope, operation, binding, objectiveRef); intent.preparationEvidence = structuredClone(currentEvidence); intents.push(intent);
      return { result: structuredClone(intent), audit: [audit(intent, "prepared", intent)] };
    });
    const existingGrant = this.#authorizations.get(result.intentId), existingApproval = this.#approvals.get(result.intentId);
    if (existingGrant && !grantMatches(existingGrant, result, scope, this.env.processEpoch, binding)) this.#authorizations.delete(result.intentId);
    if (existingApproval && !grantMatches(existingApproval, result, scope, this.env.processEpoch, binding)) this.#approvals.delete(result.intentId);
    return result;
  }
  async inspect(scope: Scope, id: string): Promise<ExecutionIntent> {
    this.guard(scope);
    const intent = await this.store.read(id);
    if (!intent) throw new AssistantError("INTENT_MISSING", "执行意图不存在。");
    owned(intent, scope, false); return intent;
  }
  async beginReview(scope: Scope, id: string, roundId: string): Promise<ReviewChallenge> {
    requireCapability(scope.role, "delegate", this.roles);
    const intent = await this.inspect(scope, id); owned(intent, scope);
    if (intent.state !== "Proposed") throw new AssistantError("REVIEW_CLOSED", "本意图不再处于准备阶段。");
    this.#approvals.delete(id);
    if (!sameBinding(intent.binding, this.trading.binding(intent.operation.name))) throw new AssistantError("REPREPARE_REQUIRED", "服务/schema 已改变；先重新准备精确方案。");
    const challenge = { intent, roundId, scope: structuredClone(scope) }; this.#rounds.set(roundId, challenge); return challenge;
  }
  async submitReview(scope: Scope, id: string, expertId: string, decision: ReviewDecision, evidence: Evidence[], provided: Evidence[] = []): Promise<{ accepted: boolean; errors: string[] }> {
    this.guard(scope); this.#approvals.delete(id);
    const challenge = this.#rounds.get(scope.roundId), intent = await this.inspect(scope, id);
    if (scope.role !== "reviewer" || !challenge || challenge.intent.intentId !== id || challenge.roundId !== scope.roundId ||
        challenge.intent.revision !== intent.revision || challenge.scope.ownerId !== scope.ownerId || challenge.scope.requestId !== scope.requestId ||
        !sameBinding(challenge.intent.binding, intent.binding) || !sameBinding(intent.binding, this.trading.binding(intent.operation.name))) {
      throw new AssistantError("REVIEW_SCOPE_DENIED", "没有本进程、本轮、当前准备版本的独立复核挑战；历史不能恢复批准。");
    }
    const errors = reviewErrors({ decision, operation: intent.operation });
    const accepted = decision.action === "APPROVE" && errors.length === 0;
    await this.store.commit(intents => {
      const stored = intents.find(i => i.intentId === id)!;
      if (stored.revision !== intent.revision || stored.state !== "Proposed") throw new AssistantError("REVIEW_STALE", "准备已变化，不能登记旧复核。");
      stored.review = { revision: intent.revision, roundId: scope.roundId, decision: serializable(decision), evidence: structuredClone([...provided, ...evidence]) };
      return { result: null, audit: [audit(stored, "reviewed", { accepted, errors, roundId: scope.roundId, expertId, decision, evidenceRefs: evidence.map(e => e.ref) })] };
    });
    if (accepted && this.env.isLive(scope)) this.#approvals.set(id, { ...this.grant(intent, scope), expertId, roundId: scope.roundId, evidenceRefs: evidence.map(e => e.ref) });
    return { accepted, errors };
  }
  private approval(intent: ExecutionIntent, scope: Scope): ApprovalLease {
    const lease = this.#approvals.get(intent.intentId);
    if (!lease || !grantMatches(lease, intent, scope, this.env.processEpoch, this.trading.binding(intent.operation.name))) {
      throw new AssistantError("REVIEW_REQUIRED", "缺少当前进程、本轮精确参数的独立批准；历史 APPROVE 无效。");
    }
    return lease;
  }
  private checkReview(intent: ExecutionIntent, scope: Scope): void {
    if (this.trading.requirements?.(intent.operation.name).reviewRequired !== false) this.approval(intent, scope);
  }
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.#locks.has(id)) throw new AssistantError("EXECUTION_BUSY", "同一意图已经等待确认或执行，不重复弹窗/发送。");
    this.#locks.add(id);
    const next = this.#tail.then(work); this.#tail = next.then(() => undefined, () => undefined);
    try { return await next; } finally { this.#locks.delete(id); }
  }
  async execute(scope: Scope, id: string, sourceRef: string, signal?: AbortSignal): Promise<ExecutionIntent> {
    this.guard(scope);
    requireCapability(scope.role, "execute", this.roles);
    const initial = await this.inspect(scope, id);
    if (initial.attempt || initial.state !== "Proposed") return initial;
    owned(initial, scope); this.allowed(initial.operation, scope);
    if (this.#denied.has(`${id}:${initial.revision}`)) throw new AssistantError("AUTHORIZATION_DENIED", "用户已经拒绝/撤销本方案；不重复请求同一许可。");
    this.checkReview(initial, scope);
    // A pending confirmation must not reserve the application-wide write lock.
    if (this.#locks.has(id)) throw new AssistantError("EXECUTION_BUSY", "同一意图正在等待确认或执行。");
    this.#locks.add(id);
    const existingGrant = this.#authorizations.get(id);
    let confirmed = !!existingGrant && grantMatches(existingGrant, initial, scope, this.env.processEpoch, initial.binding);
    try { if (!confirmed) confirmed = await this.interaction.confirm({ intentId: id, revision: initial.revision, operation: initial.operation,
      binding: initial.binding, description: this.trading.catalog().find(tool => tool.name === initial.operation.name)?.description ?? "" }, signal); }
    finally { this.#locks.delete(id); }
    this.guard(scope);
    if (!confirmed) {
      this.#denied.add(`${id}:${initial.revision}`);
      return this.store.commit(intents => {
        const intent = intents.find(i => i.intentId === id)!;
        if (intent.state === "Proposed" && intent.revision === initial.revision) intent.state = "Abandoned";
        return { result: structuredClone(intent), audit: [audit(intent, "user_declined", { revision: initial.revision })] };
      });
    }
    this.#authorizations.set(id, this.grant(initial, scope));
    return this.locked(id, async () => {
      this.guard(scope);
      let intent = await this.inspect(scope, id);
      this.checkAuthorization(intent, scope); this.allowed(intent.operation, scope); this.checkReview(intent, scope);
      if ((await this.store.list()).some(i => i.intentId !== id && unresolved(i))) throw new AssistantError("UNRESOLVED_OBLIGATION", "其他发送义务未解决；未开始本次发送。");
      await this.trading.refresh(signal); this.guard(scope);
      this.checkAuthorization(intent, scope); this.allowed(intent.operation, scope); this.checkReview(intent, scope);
      intent = await this.attempt(intent, scope, sourceRef);
      await this.transmit(intent, scope, signal);
      intent = await this.store.read(id) ?? intent;
      return intent;
    }).finally(async () => {
      const current = await this.store.read(id);
      if (current?.attempt || !this.env.isLive(scope)) { this.#authorizations.delete(id); this.#approvals.delete(id); }
    });
  }
  private checkAuthorization(intent: ExecutionIntent, scope: Scope): void {
    const grant = this.#authorizations.get(intent.intentId);
    if (!grant || !grantMatches(grant, intent, scope, this.env.processEpoch, this.trading.binding(intent.operation.name))) {
      throw new AssistantError("AUTHORIZATION_REQUIRED", "当前服务、schema、准备版本或精确参数没有有效用户许可。");
    }
  }
  private async attempt(intent: ExecutionIntent, scope: Scope, sourceRef: string): Promise<ExecutionIntent> {
    this.guard(scope);
    try {
      return await this.store.commit(intents => {
        const stored = intents.find(i => i.intentId === intent.intentId)!;
        if (stored.revision !== intent.revision || !sameOperation(stored.operation, intent.operation) || !sameBinding(stored.binding, intent.binding)) throw new AssistantError("PREPARATION_STALE", "发送前准备版本已变化。");
        startAttempt(stored, { attemptId: this.env.id(), startedAt: this.env.now(), sourceRef });
        return { result: structuredClone(stored), audit: [audit(stored, "dispatch_started", stored.attempt)] };
      });
    } catch (error) { if (!(error instanceof AssistantError) && !(error instanceof ExecutionViolation)) this.poison(); throw error; }
  }
  private permit(intent: ExecutionIntent, scope: Scope): DispatchPermit {
    let consumed = false;
    return { consume: (actualBinding, operation, actualScope) => {
      this.guard(scope);
      if (consumed || actualScope.requestId !== scope.requestId || actualScope.ownerId !== scope.ownerId || actualScope.role !== scope.role ||
          !sameOperation(operation, intent.operation) || !sameBinding(actualBinding, intent.binding)) throw new AssistantError("DISPATCH_PERMIT_DENIED", "单次许可、作用域、服务或参数不匹配。");
      requireCapability(scope.role, "execute", this.roles);
      this.allowed(operation, scope); this.checkAuthorization(intent, scope); this.checkReview(intent, scope);
      consumed = true;
      this.#authorizations.delete(intent.intentId); this.#approvals.delete(intent.intentId);
    } };
  }
  private async transmit(intent: ExecutionIntent, scope: Scope, signal?: AbortSignal): Promise<void> {
    let observation: NativeObservation;
    try { observation = await this.trading.dispatch(this.permit(intent, scope), intent.operation, scope, signal); }
    catch (error) {
      try { await this.store.commit(intents => {
        const stored = intents.find(i => i.intentId === intent.intentId)!;
        if (error instanceof AssistantError && error.code === "PROVEN_NOT_SENT") stored.state = "ProvenNotSent";
        else markUnknown(stored);
        return { result: null, audit: [audit(stored, stored.state === "ProvenNotSent" ? "proven_not_sent" : "result_unknown")] };
      }); } catch { this.poison(); }
      return;
    }
    try { await this.store.commit(intents => {
      const stored = intents.find(i => i.intentId === intent.intentId)!;
      observe(stored, { observedAt: this.env.now(), ...observation });
      return { result: null, audit: [audit(stored, "observed", stored.observation)] };
    }); } catch {
      this.#uncommitted.set(intent.intentId, observation); this.poison();
      this.env.emergency("[可靠存储故障] 已取得远端回执但未能可靠保存。禁止新写；不能宣称未执行。重开后先核对真实状态。");
      throw new AssistantError("RECEIPT_UNCOMMITTED", "已知远端回执未可靠归档；写入路径已关闭。");
    }
  }
  /** Control-plane only. Never registered as a model tool. */
  async resolve(ownerId: number, id: string, revision: number, note: string): Promise<ExecutionIntent> {
    if (this.#poisoned) throw new AssistantError("EXECUTION_STORAGE_FAILED", "写入路径已关闭；重开后核对记录。");
    if (!note.trim() || note.length > 4000) throw new AssistantError("RESOLUTION_NOTE_REQUIRED", "人工结案必须提供不超过 4000 字的核对依据。");
    return this.locked(id, () => this.store.commit(intents => {
      const intent = intents.find(item => item.intentId === id);
      if (!intent || intent.ownerId !== ownerId || intent.revision !== revision || intent.state !== "Unknown") {
        throw new AssistantError("RESOLUTION_SCOPE_DENIED", "只能结案当前会话中这个精确版本的未知意图。");
      }
      resolveUnknown(intent, this.env.now(), note.trim());
      return { result: structuredClone(intent), audit: [audit(intent, "manually_resolved", intent.reconciliation)] };
    }));
  }
  async recover(): Promise<void> {
    this.revoke();
    await this.store.commit(intents => {
      const events: IntentAudit[] = [];
      for (const intent of intents) if (intent.state === "DispatchStarted" && !intent.observation) { markUnknown(intent); events.push(audit(intent, "recovery_unknown")); }
      return { result: null, audit: events };
    });
  }
  revoke(): void {
    for (const grant of this.#authorizations.values()) this.#denied.add(`${grant.intentId}:${grant.revision}`);
    this.#authorizations.clear(); this.#approvals.clear(); this.#rounds.clear(); this.interaction.revoke();
  }
  private poison(): void { this.#poisoned = true; this.revoke(); }
  async status(): Promise<Json> {
    return { writePathHealthy: !this.#poisoned, unsettled: (await this.store.list()).filter(unresolved).map(i =>
      ({ intentId: i.intentId, ownerId: i.ownerId, state: i.state, operation: i.operation.name })), uncommittedReceiptIds: [...this.#uncommitted.keys()] };
  }
}

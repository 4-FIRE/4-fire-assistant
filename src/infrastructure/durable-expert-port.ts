import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry, LiveDoc, configure, defineTask,
  type AgentChange, type ConversationId, type Harness, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { AssistantError } from "../application/ports.js";
import type { Report, ToolPort } from "../application/business-ports.js";
import type { ExecutionService } from "../application/execution.js";
import type { DelegatedWork, ExpertPort } from "../application/experts.js";
import type { ExecutionIntent } from "../domain/execution.js";
import type { Evidence, Role, Scope } from "../domain/shared.js";
import { ArtifactDoc, ExpertDoc, RoundDoc, TeamDoc, WorkDoc, json, type Delegation } from "./runtime-documents.js";
import type { ResourceSnapshot } from "./resources.js";

export const ExpertAnchor = defineTask<null, { phase: "done" }, null>({
  name: "fire.expert-anchor", version: 1, initial: () => ({ phase: "done" }),
  phases: { done: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx) },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
interface ExpertOptions {
  resources: ResourceSnapshot;
  trading: ToolPort | undefined;
  execution(): ExecutionService;
  harness: Harness;
  agent(role: Role): AgentChange;
  scope(api: ToolExecutionApi, ctx: Context): Promise<Scope>;
}
export function durableExpertPort(api: ToolExecutionApi, ctx: Context, options: ExpertOptions): ExpertPort {
  const lookup = async (work: DelegatedWork) => {
    const team = await api.snapshot(TeamDoc, api.conversationId, ctx);
    const delegation = team?.delegations.find(d => d.key === work.key);
    if (!delegation) throw new AssistantError("DELEGATION_MISSING", "委派关联缺失；不能创建替代任务。");
    return delegation;
  };
  return {
    reserve: async (scope, key, input) => {
      let challenge: ExecutionIntent | undefined;
      if (input.intentId) {
        challenge = input.role === "reviewer" ? (await options.execution().beginReview(scope, input.intentId, key)).intent : await options.execution().inspect(scope, input.intentId);
        const rootRound = await api.snapshot(RoundDoc, scope.ownerId as ConversationId, scope.requestId, ctx);
        input = { ...input, reportRefs: [...new Set([...(input.reportRefs ?? []), ...challenge.preparationEvidence.map(e => e.ref), ...(rootRound?.evidenceRefs ?? [])])],
          goal: `${input.goal}\n\n${options.resources.promptText("runtime", "intentSnapshot")}${JSON.stringify({ intentId: challenge.intentId, revision: challenge.revision, operation: challenge.operation, binding: challenge.binding,
            schema: options.trading?.catalog().find(t => t.name === challenge!.operation.name)?.schema,
            service: options.trading?.status?.(), previousReview: null })}` };
      }
      for (const ref of input.reportRefs ?? []) {
        if (!await api.snapshot(ArtifactDoc, scope.ownerId as ConversationId, ref, ctx)) throw new AssistantError("REPORT_UNAVAILABLE", "提供的报告不属于本主会话。");
      }
      const delegation = await api.commit(async tx => {
        const team = await tx.doc(TeamDoc, scope.ownerId as ConversationId);
        const existing = team.delegations.find(d => d.key === key);
        if (existing) return json(existing) as unknown as Delegation;
        let expert = input.expertId ? team.experts.find(e => e.expertId === input.expertId && e.role === input.role) : undefined;
        if (input.expertId && !expert) throw new AssistantError("EXPERT_UNAVAILABLE", "该专家不属于本会话或角色不匹配。");
        if (expert && ((await tx.doc(LiveDoc, expert.conversationId)).run || expert.active)) {
          // A cancelled main request has already aborted the expert; retain identity/history and open a new round.
          const previous = team.delegations.find(d => d.roundId === expert!.active);
          const work = await tx.doc(WorkDoc, scope.ownerId as ConversationId);
          if ((await tx.doc(LiveDoc, expert.conversationId)).run || previous?.ownerRequestId === work.request?.requestId) {
            throw new AssistantError("EXPERT_BUSY", "该专家正在处理另一委派；请选择等待或新实例。");
          }
        }
        if (!expert) {
          const anchor = await tx.createTask(ExpertAnchor, null, { conversationId: scope.ownerId as ConversationId, ownership: { kind: "conversation" }, background: true });
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
          await configure(tx, child.id, options.agent(input.role));
          expert = { expertId: randomUUID(), role: input.role, conversationId: child.id, purpose: input.goal, reportRefs: [], active: null };
          team.experts.push(expert);
          // Chord adopts values by clone; mutate the draft, not the pre-push plain object.
          expert = team.experts[team.experts.length - 1]!;
        }
        const roundId = key;
        const binding = await tx.doc(ExpertDoc, expert.conversationId);
        Object.assign(binding, { role: input.role, ownerId: scope.ownerId, requestId: scope.requestId, roundId, allowedRefs: input.reportRefs ?? [] });
        const roundScope = { ...scope, conversationId: expert.conversationId, role: input.role, roundId };
        const round = await tx.doc(RoundDoc, expert.conversationId, roundId, json(roundScope));
        round.intentId = input.intentId ?? null;
        const delegation: Delegation = { key, expertId: expert.expertId, conversationId: expert.conversationId,
          ownerId: scope.ownerId as ConversationId, ownerRequestId: scope.requestId, role: input.role,
          goal: input.goal, requestId: key, roundId, submissionId: null, reportRef: null };
        expert.active = roundId;
        team.delegations.push(delegation);
        return json(delegation) as unknown as Delegation;
      }, ctx);
      return { key, expertId: delegation.expertId, roundId: delegation.roundId };
    },
    deliver: async work => {
      const delegation = await lookup(work);
      if (delegation.reportRef) return;
      await options.scope(api, ctx); // Also executes during safe replay, not only in a hook.
      const child = await api.conversation(delegation.conversationId, ctx);
      if (!child) throw new AssistantError("EXPERT_MISSING", "专家会话缺失，不能替代。");
      const submission = await child.submit({ type: "input", content: delegation.goal,
        requestId: delegation.requestId, whenBusy: "reject" }, ctx);
      await api.commit(async tx => {
        const stored = (await tx.doc(TeamDoc, api.conversationId)).delegations.find(d => d.key === work.key)!;
        stored.submissionId = submission.id;
      }, ctx);
    },
    collect: async work => {
      const delegation = await lookup(work);
      if (delegation.reportRef) return (await api.snapshot(ArtifactDoc, delegation.ownerId, delegation.reportRef, ctx))!.value as unknown as Report;
      if (delegation.submissionId === null) throw new AssistantError("DELEGATION_UNADMITTED", "委派尚未完成投递。");
      const submission = await options.harness.submission(delegation.submissionId, ctx);
      if (!submission) throw new AssistantError("SUBMISSION_MISSING", "专家输入身份不存在；不能重复生成替代输入。");
      const settled = await submission.wait(ctx);
      const round = await api.snapshot(RoundDoc, delegation.conversationId, delegation.roundId, ctx);
      const evidence: Evidence[] = [];
      for (const ref of round?.evidenceRefs ?? []) {
        const receipt = await api.snapshot(ArtifactDoc, delegation.ownerId, ref, ctx);
        if (receipt) evidence.push(receipt.value as unknown as Evidence);
      }
      return api.commit(async tx => {
        const team = await tx.doc(TeamDoc, delegation.ownerId);
        const expert = team.experts.find(e => e.expertId === delegation.expertId)!;
        const stored = team.delegations.find(d => d.key === work.key)!;
        let content = "专家未交付最终回答；不能据此否定此前工具回执。";
        if (settled.status === "done" && settled.type === "input") {
          const answer = await tx.entry(AssistantEntry, settled.answer);
          const body = answer?.model?.[0]?.content ?? [];
          content = typeof body === "string" ? body : body.filter(part => part.type === "text").map(part => part.text).join("");
        }
        const report: Report = { ref: `report:${work.key}`, ownerId: delegation.ownerId, requestId: delegation.ownerRequestId,
          expertId: delegation.expertId, role: delegation.role, createdAt: new Date().toISOString(), content, evidence,
          status: settled.status === "done" ? "answered" : settled.reason === "aborted" ? "cancelled" : "unanswered" };
        await tx.doc(ArtifactDoc, delegation.ownerId, report.ref, json(report));
        stored.reportRef = report.ref;
        if (!expert.reportRefs.includes(report.ref)) expert.reportRefs.push(report.ref);
        if (expert.active === work.roundId) expert.active = null;
        return report;
      }, ctx);
    },
  };
}

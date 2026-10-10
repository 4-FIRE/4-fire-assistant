import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { AssistantError } from "../application/ports.js";
import type { ToolPort } from "../application/business-ports.js";
import type { ExecutionService } from "../application/execution.js";
import type { ExecutionIntent, ReviewDecision } from "../domain/execution.js";
import { canonical, type Evidence, type Json, type Parameters, type Scope } from "../domain/shared.js";
import { ArtifactDoc, ExpertDoc, RoundDoc, TeamDoc, json } from "./runtime-documents.js";
import type { ResourceSnapshot } from "./resources.js";
import type { WorkspaceServices } from "./workspace-services.js";
import { result } from "./tool-result.js";

interface ExecutionToolOptions {
  resources: ResourceSnapshot;
  services: WorkspaceServices | undefined;
  trading: ToolPort | undefined;
  execution(): ExecutionService;
  run(api: ToolExecutionApi, ctx: Context, call: (scope: Scope) => Promise<ReturnType<typeof result>>): Promise<ReturnType<typeof result>>;
  evidence(api: ToolExecutionApi, scope: Scope, operation: string, parameters: Parameters, value: Json, success: boolean, binding?: Evidence["binding"], raw?: Json): Promise<Evidence>;
}

export function executionTools(options: ExecutionToolOptions): ToolRegistration[] {
  const nativeParameters = Type.Record(Type.String(), Type.Unknown());
  async function roundEvidence(api: ToolExecutionApi, scope: Scope, ctx: Context): Promise<Evidence[]> {
    const round = await api.snapshot(RoundDoc, api.conversationId, scope.roundId, ctx), evidence: Evidence[] = [];
    for (const ref of round?.evidenceRefs ?? []) {
      const value = (await api.snapshot(ArtifactDoc, scope.ownerId as ConversationId, ref, ctx))?.value;
      if (value) evidence.push(value as unknown as Evidence);
    }
    return evidence;
  }
  async function intentResult(api: ToolExecutionApi, scope: Scope, intent: ExecutionIntent) {
    const receipt = await options.evidence(api, scope, intent.operation.name, intent.operation.parameters, json(intent), intent.observation?.success ?? false, intent.binding);
    return result({ intentId: intent.intentId, revision: intent.revision, state: intent.state, operation: intent.operation, attempt: intent.attempt,
      observation: intent.observation, reconciliation: intent.reconciliation, receiptRef: receipt.ref,
      warning: options.resources.promptText("runtime", "intentStatus") }, ["DispatchStarted", "Unknown", "ProvenNotSent", "Abandoned"].includes(intent.state) || intent.observation?.success === false);
  }
  return [
    defineTool({ name: "prepare_write", description: options.resources.promptText("tools", "prepare_write"),
      parameters: Type.Object({ operation: Type.String(), parameters: nativeParameters, objectiveRef: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }), replay: "safe",
      execute: async (args, api, ctx) => options.run(api, ctx, async scope => {
        options.services?.requireInitialized();
        canonical(args.parameters as Json);
        const intent = await options.execution().prepare(scope, { name: args.operation, parameters: json(args.parameters) as Parameters }, args.objectiveRef, await roundEvidence(api, scope, ctx));
        return result({ intentId: intent.intentId, revision: intent.revision, state: intent.state, operation: intent.operation, binding: intent.binding,
          requirements: options.trading!.requirements?.(intent.operation.name),
          schema: options.trading!.catalog().find(t => t.name === intent.operation.name)?.schema, authorized: false });
      }) }),
    defineTool({ name: "submit_review", description: options.resources.promptText("tools", "submit_review"),
      parameters: Type.Object({ intentId: Type.String(), decision: Type.Object({ action: Type.Union([Type.Literal("APPROVE"), Type.Literal("REJECT")]) }, { additionalProperties: false }) }, { additionalProperties: false }), replay: "safe",
      execute: async (args, api, ctx) => options.run(api, ctx, async scope => {
        const round = await api.snapshot(RoundDoc, api.conversationId, scope.roundId, ctx), expert = await api.snapshot(ExpertDoc, api.conversationId, ctx);
        if (scope.role !== "reviewer" || round?.intentId !== args.intentId) throw new AssistantError("REVIEW_SCOPE_DENIED", "复核必须对应当前专家的实际意图/轮次。");
        const team = await api.snapshot(TeamDoc, scope.ownerId as ConversationId, ctx), identity = team?.experts.find(e => e.conversationId === scope.conversationId);
        if (!identity) throw new AssistantError("REVIEW_SCOPE_DENIED", "独立复核身份缺失。");
        const provided: Evidence[] = [];
        for (const ref of expert?.allowedRefs ?? []) {
          const value = (await api.snapshot(ArtifactDoc, scope.ownerId as ConversationId, ref, ctx))?.value;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            if ("scope" in value) provided.push(value as unknown as Evidence);
            else if ("evidence" in value && Array.isArray(value.evidence)) provided.push(...value.evidence as unknown as Evidence[]);
          }
        }
        canonical(args.decision as unknown as Json);
        const intent = await options.execution().inspect(scope, args.intentId);
        const decision: ReviewDecision = { action: args.decision.action, operation: intent.operation };
        const outcome = await options.execution().submitReview(scope, args.intentId, identity.expertId, decision, await roundEvidence(api, scope, ctx), provided);
        await api.commit(async tx => { (await tx.doc(RoundDoc, api.conversationId, scope.roundId, json(scope))).decision = json({ ...outcome, decision }); }, context);
        return result(outcome, args.decision.action === "APPROVE" && !outcome.accepted);
      }) }),
    defineTool({ name: "execute_write", description: options.resources.promptText("tools", "execute_write"),
      parameters: Type.Object({ intentId: Type.String() }, { additionalProperties: false }), replay: "unsafe",
      execute: async (args, api, ctx) => options.run(api, ctx, async scope => {
        options.services?.requireInitialized();
        const intent = await options.execution().execute(scope, args.intentId, `tool:${api.taskId}`, ctx.abortSignal);
        return intentResult(api, scope, intent);
      }) }),
    defineTool({ name: "read_intent", description: options.resources.promptText("tools", "read_intent"),
      parameters: Type.Object({ intentId: Type.String() }, { additionalProperties: false }), replay: "safe",
      execute: async (args, api, ctx) => options.run(api, ctx, async scope => intentResult(api, scope, await options.execution().inspect(scope, args.intentId))) }),
  ];
}

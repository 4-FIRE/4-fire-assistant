import type { ExtensionAPI, ExtensionToolContext, ToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { RecordService } from "../services/record-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { ExpertRun } from "../services/expert-service.js";
import type { CallAccess } from "../tools/access.js";
import { providersTool } from "../tools/providers.js";
import { providerCallTool } from "../tools/provider-call.js";
import type { Confirmations } from "../ui/confirmation.js";
import { recordTool } from "../tools/record.js";
import { pythonTool } from "../tools/python.js";
import { submitReviewTool } from "../tools/submit-review.js";
import { PiExperts } from "./pi-experts.js";

export function bindExpertRun(pi: ExtensionAPI, host: PiExperts, providers: ProviderRegistry, records: RecordService,
  research: ResearchService, access: CallAccess, ctx: ExtensionToolContext, signal: AbortSignal,
  progress: (value: unknown) => void, confirmations: Confirmations): ExpertRun {
  const sessionId = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
  return async task => {
    access.check(true);
    const tools: ToolDefinition[] = [
      providersTool(providers, access),
      providerCallTool({ call: (_scope, provider, operation, parameters, _confirm, callSignal) =>
        task.call(access.scope(sessionId), provider, operation, parameters,
          value => confirmations.ask(ctx, "批准专家本次工具调用", value,
            callSignal ? AbortSignal.any([signal, callSignal]) : signal), callSignal) }, access, confirmations),
      recordTool(records, access), pythonTool(research, access),
    ];
    if (task.submitReview) tools.push(submitReviewTool(task.submitReview, access));
    return host.run(ctx, task.role, task.goal, tools, ref => {
      signal.throwIfAborted(); access.check(true);
      assertExpertBranch(ctx.sessionManager, sessionId, leaf);
      task.remember(ref);
      if (!task.previous) pi.appendEntry("ffa.expert", { ...ref });
    }, task.previous, signal, progress);
  };
}

export function assertExpertBranch(manager: Pick<SessionManager, "getSessionId" | "getBranch">, sessionId: string, ancestor: string | null) {
  // Normal appends advance the leaf without leaving the dispatching branch.
  if (manager.getSessionId() !== sessionId || ancestor !== null && !manager.getBranch().some(entry => entry.id === ancestor)) {
    throw new Error("专家调用所属会话分支已变化。");
  }
}

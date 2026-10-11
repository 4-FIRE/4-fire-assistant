import type { ExtensionAPI, ExtensionToolContext, ToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SourceService } from "../services/source-service.js";
import type { RecordService } from "../services/record-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { ExpertRun } from "../services/expert-service.js";
import type { CallAccess } from "../tools/access.js";
import { sourcesTool } from "../tools/sources.js";
import { sourceReadTool } from "../tools/source-read.js";
import { recordTool } from "../tools/record.js";
import { pythonTool } from "../tools/python.js";
import { submitReviewTool } from "../tools/submit-review.js";
import { PiExperts } from "./pi-experts.js";

export function bindExpertRun(pi: ExtensionAPI, host: PiExperts, sources: SourceService, records: RecordService,
  research: ResearchService, access: CallAccess, ctx: ExtensionToolContext, signal: AbortSignal,
  progress: (value: unknown) => void): ExpertRun {
  const sessionId = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
  return async task => {
    access.check(true);
    const tools: ToolDefinition[] = [
      sourcesTool(sources, access),
      sourceReadTool({ read: (source, operation, parameters, callSignal) => task.read(source, operation, parameters, callSignal) }, access),
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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecution } from "../model/agent.js";
import type { AgentService } from "../services/agent-service.js";

export function agentContext(service: AgentService, ctx: ExtensionContext) {
  const values = new Map<string, AgentExecution>(), reported = new Set<string>();
  const branch = ctx.sessionManager.getBranch();
  // Pi totals include abandoned branches of this file; accounting follows that scope, not report ownership.
  const accounting = ctx.sessionManager.getEntries();
  const persistedUsage = new Set(accounting.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage
    ? [entry.message.toolCallId] : []));
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === "ffa.agent-run") {
      const value = entry.data as AgentExecution; values.set(value.runId, value);
    }
  }
  for (const entry of accounting) {
    if (entry.type === "custom" && entry.customType === "ffa.agent-usage") {
      const receipt = entry.data as { runIds: string[]; toolCallId: string };
      if (persistedUsage.has(receipt.toolCallId)) for (const runId of receipt.runIds) reported.add(runId);
    }
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      const runIds = (entry.message.details as { agentUsageRunIds?: string[] } | undefined)?.agentUsageRunIds;
      if (runIds) for (const runId of runIds) reported.add(runId);
    }
  }
  service.restore([...values.values()], reported);
  return { runIds: new Set(values.keys()), reported };
}

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentExecution } from "../../model/agent.js";

/** Extract native branch ownership and file-wide accounting without changing service state. */
export function agentContext(manager: Pick<SessionManager, "getBranch" | "getEntries">) {
  const values = new Map<string, AgentExecution>(), reported = new Set<string>();
  const branch = manager.getBranch();
  // Pi totals include abandoned branches of this file; accounting follows that scope, not report ownership.
  const accounting = manager.getEntries();
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
  return { values: structuredClone([...values.values()]), runIds: new Set(values.keys()), reported };
}

export function assertAgentBranch(manager: Pick<SessionManager, "getSessionId" | "getBranch">, sessionId: string, ancestor: string | null) {
  if (manager.getSessionId() !== sessionId || ancestor !== null && !manager.getBranch().some(entry => entry.id === ancestor)) {
    throw new Error("专家调用所属会话分支已变化。");
  }
}

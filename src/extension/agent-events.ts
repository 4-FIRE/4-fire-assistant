import type { ExtensionAPI, ExtensionContext, CustomMessageEntryDraft, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Lifecycle, WorkspaceInstance } from "./lifecycle.js";
import type { Confirmations } from "../ui/confirmation.js";
import { agentContext } from "../tools/agent-context.js";
import { agentBoard } from "../ui/agent-display.js";
import { agentConcurrency } from "../services/agent-queue.js";

/** Delivers only at public Pi boundaries; no queued notification crosses navigation. */
export function registerAgentEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  let owner: WorkspaceInstance | undefined, current: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const detach = () => {
    clearTimer(); unsubscribe?.(); unsubscribe = undefined;
    if (current?.mode === "tui") current.ui.setWidget("ffa-agents", undefined);
    owner = undefined; current = undefined;
  };
  const valid = () => owner && owner === lifecycle.active && current;
  const notification = (): CustomMessageEntryDraft | undefined => {
    if (!valid() || paused || current!.signal?.aborted) return;
    const { runIds } = agentContext(owner!.agents, current!);
    const pending = owner!.agents.pending(runIds).slice(0, 8);
    if (!pending.length) return;
    owner!.agents.claim(pending.map(value => value.runId));
    return { type: "custom_message", customType: "ffa.agent-results", display: true,
      content: "后台专家已交付。只推进原用户请求；交付成功不等于复核通过或执行许可。完整报告用 ffa_agent action=read 读取，不重发未知调用。\n" +
        pending.map(value => JSON.stringify({ runId: value.runId, agent: value.agent, state: value.state,
          message: value.message.slice(0, 400), report: value.report.slice(0, 1600), error: value.error })).join("\n"),
      details: { runIds: pending.map(value => value.runId) } };
  };
  const refresh = () => {
    if (!valid()) return;
    const { runIds } = agentContext(owner!.agents, current!);
    const values = owner!.agents.list(runIds);
    if (current!.mode === "tui") current!.ui.setWidget("ffa-agents",
      values.some(value => !value.finishedAt) ? (_tui, theme) => agentBoard(values, theme, agentConcurrency) : undefined);
    if (paused || !owner!.agents.pending(runIds).length || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!valid() || !current!.isIdle()) return;
      const message = notification();
      if (message) pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
    }, 150);
  };
  const attach = (ctx: ExtensionContext) => {
    if (owner !== lifecycle.active) {
      detach(); owner = lifecycle.active;
      if (owner) unsubscribe = owner.agents.subscribe(refresh);
    }
    current = ctx; refresh();
  };
  const boundary = (outcome: string, entries: SessionBoundaryDraft[], ctx: ExtensionContext) => {
    attach(ctx);
    if (outcome === "aborted" || ctx.signal?.aborted) {
      paused = true; clearTimer(); confirmations.pause(); return;
    }
    clearTimer();
    const message = notification();
    if (message) return { entries: [...entries, message], continue: true };
    return;
  };
  pi.on("session_start", (_event, ctx) => { paused = false; confirmations.resume(); attach(ctx); });
  pi.on("before_agent_start", (_event, ctx) => { attach(ctx); });
  pi.on("input", (_event, ctx) => { paused = false; confirmations.resume(); attach(ctx); });
  pi.on("turn_end", (event, ctx) => boundary(event.outcome, event.entries, ctx));
  pi.on("agent_before_settle", (event, ctx) => boundary(event.outcome, event.entries, ctx));
  pi.on("tool_result", event => {
    if (!lifecycle.active || event.toolName !== "ffa_agent") return;
    const runIds = (event.details as { agentUsageRunIds?: string[] } | undefined)?.agentUsageRunIds;
    if (runIds?.length) pi.appendEntry("ffa.agent-usage", { runIds, toolCallId: event.parentToolCallId ?? event.toolCallId });
    return;
  });
  pi.on("agent_settled", (event, ctx) => {
    current = ctx;
    if (valid()) owner!.agents.reconcileUsage(agentContext(owner!.agents, ctx).reported);
    if (event.aborted) { paused = true; clearTimer(); confirmations.pause(); }
    else refresh();
  });
  const navigate = async () => {
    detach(); confirmations.pause();
    const instance = lifecycle.active;
    instance?.cancelAgents();
    await instance?.agents.reset();
  };
  pi.on("session_before_switch", navigate);
  pi.on("session_before_fork", navigate);
  pi.on("session_before_tree", navigate);
  pi.on("session_shutdown", () => { detach(); confirmations.pause(); });
}

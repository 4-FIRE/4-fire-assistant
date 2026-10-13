import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkspaceInstance } from "./lifecycle.js";
import { agentContext } from "../tools/agent-context.js";
import { agentHistory } from "../integrations/pi-agents.js";
import { agentSummary } from "../ui/agent-display.js";
import { AgentViewer } from "../ui/agent-viewer.js";
import { agentDefinitions } from "../integrations/agent-resources.js";
import type { Confirmations } from "../ui/confirmation.js";

export async function showAgents(pi: ExtensionAPI, instance: WorkspaceInstance, ctx: ExtensionCommandContext, confirmations: Confirmations) {
  instance.check(true);
  const { runIds } = agentContext(instance.agents, ctx), values = instance.agents.list(runIds);
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(JSON.stringify({ agents: await agentDefinitions(instance.root),
      runs: values.map(value => ({ ...value, report: value.report.slice(0, 16000) })) }, null, 2), "info");
    return;
  }
  if (!values.length) { ctx.ui.notify("当前分支没有专家执行；用 ffa_agent action=start 委派。", "info"); return; }
  if (confirmations.presenting) { ctx.ui.notify("请先处理当前批准，再查看专家。", "info"); return; }
  const cancel = instance.signal(undefined, true);
  const select = async (title: string, options: string[]) => {
    const interrupted = new AbortController(), signal = AbortSignal.any([cancel, interrupted.signal]);
    const unsubscribe = pi.on("ui_prompt_start", event => { if (event.title !== title) interrupted.abort(); });
    try { return await ctx.ui.select(title, options, { signal }); }
    finally { unsubscribe(); }
  };
  const options = values.map(agentSummary);
  const selected = await select("ffa 专家执行", options);
  if (!selected) return;
  const runId = values[options.indexOf(selected)]?.runId;
  if (!runId) return;
  const action = await select("专家操作", ["阅读报告", "查看会话", "停止"]);
  if (!action) return;
  if (action === "停止") { instance.agents.stop(runId, runIds); return; }
  let viewer: AgentViewer | undefined;
  let historyKey = "", historyText = "";
  const removePrompt = pi.on("ui_prompt_start", () => { viewer?.finish(); });
  try {
    await ctx.ui.custom<void>((tui, theme, keys, done) => {
      viewer = new AgentViewer("ffa · " + runId, async () => {
        const value = instance.agents.read(runId, runIds, false);
        const key = value.session ? JSON.stringify([value.session.file, value.session.leaf]) : "";
        if (action === "查看会话" && value.session && key !== historyKey) {
          const text = await agentHistory(instance.root, ctx.sessionManager.getSessionDir(), value.session);
          historyText = text; historyKey = key;
        }
        const history = action === "查看会话" ? historyText : "";
        return agentSummary(value) + "\n\n" + (history || value.report || value.error || "等待专家交付") +
          (action === "查看会话" && !value.finishedAt && value.report ? "\n\n## 当前回答\n" + value.report : "");
      }, listener => instance.agents.subscribe(listener), () => tui.terminal.rows, () => tui.requestRender(), done, keys, theme, cancel);
      return viewer;
    }, { overlay: true, overlayOptions: { width: "90%", anchor: "center" } });
  } finally { removePrompt(); viewer?.dispose(); }
}

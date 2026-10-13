import { Text, Markdown, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme, type ThemeColor, type ThemeBg } from "@earendil-works/pi-coding-agent";
import type { AgentExecution, AgentState, SteeringStatus } from "../model/agent.js";

const states: Record<AgentState, { icon: string; label: string; color: ThemeColor }> = {
  queued: { icon: "◦", label: "排队", color: "dim" },
  running: { icon: "●", label: "运行", color: "accent" },
  completed: { icon: "✓", label: "完成", color: "success" },
  failed: { icon: "×", label: "失败", color: "error" },
  cancelled: { icon: "■", label: "已取消", color: "muted" },
  interrupted: { icon: "!", label: "中断", color: "warning" },
};
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
function elapsed(value: AgentExecution) {
  const seconds = Math.max(0, Math.floor(((value.finishedAt ?? Date.now()) - (value.startedAt ?? value.createdAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function usageText(value: AgentExecution) {
  const tokens = value.usage.totalTokens;
  const count = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
  const cost = value.usage.cost.total;
  return `${count} tokens` + (cost > 0 ? ` · ${cost < 0.0001 ? "<$0.0001" : "~$" + cost.toFixed(4)}` : "");
}
export function agentSummary(value: AgentExecution) {
  const status = states[value.state];
  return `${status.icon} ${value.agent} · ${value.runId.slice(0, 8)} · ${status.label} · ${value.mode === "background" ? "后台" : "前台"} · ${oneLine(value.activity)} · ${elapsed(value)}`;
}
export function agentCard(value: AgentExecution & { messageStatus?: SteeringStatus }, expanded: boolean, theme: Theme, background: ThemeBg): Component {
  return {
    invalidate() {},
    render(width) {
      width = Math.max(1, width);
      if (!value?.runId) return new Text("专家", 0, 0).render(width);
      const status = states[value.state], innerWidth = Math.max(1, width - 3);
      const lines = [
        theme.fg(status.color, status.icon) + " " + theme.style(value.agent, { fg: "text", bold: true }) + "  " +
          theme.fg(status.color, status.label) + theme.fg("dim", ` · ${value.mode === "background" ? "后台" : "前台"}`),
        theme.fg("dim", `#${value.runId.slice(0, 8)} · ${elapsed(value)} · ${usageText(value)}`),
        theme.fg("muted", "目标 ") + oneLine(value.message),
      ];
      if (!value.finishedAt) lines.push(theme.fg("accent", "↳ ") + theme.fg("muted", oneLine(value.activity)));
      if (value.messageStatus) lines.push(theme.fg("success",
        value.messageStatus === "queued" ? "↳ 补充信息已入队，等待模型读取" : "↳ 补充信息已由输入入口处理"));
      if (value.error) lines.push(theme.fg("error", oneLine(value.error)));
      if (expanded && value.report) lines.push(...new Markdown(value.report, 0, 0, getMarkdownTheme()).render(innerWidth));
      else if (value.report) lines.push(theme.fg("muted", oneLine(value.report)));
      // Native truncation emits SGR 0 around the ellipsis. Restore the surrounding tool shell background.
      const restoreBackground = "\x1b[0m" + theme.getBgAnsi(background);
      return lines.map((line, index) => truncateToWidth(
        theme.fg("borderMuted", index === 0 ? "╭─ " : index === lines.length - 1 ? "╰─ " : "│  ") + line, width)
        .replace(/\x1b\[0m/g, restoreBackground));
    },
  };
}
export function agentBoard(values: AgentExecution[], theme: Theme, concurrency: number): Component {
  return {
    invalidate() {},
    render(width) {
      width = Math.max(1, width);
      const active = values.filter(value => !value.finishedAt);
      if (!active.length) return [];
      const running = active.filter(value => value.state === "running");
      const queued = active.filter(value => value.state === "queued").length;
      const lines = [theme.style("● 专家", { fg: "accent", bold: true }) +
        theme.fg("muted", ` · 运行 ${running.length}/${concurrency} · 排队 ${queued}`)];
      running.slice(0, concurrency).forEach((value, index, visible) => {
        lines.push(theme.fg("borderMuted", index === visible.length - 1 ? "└─ " : "├─ ") +
          theme.fg("accent", states[value.state].icon) + " " + theme.style(value.agent, { fg: "text", bold: true }) +
          theme.fg("dim", ` #${value.runId.slice(0, 8)} · ${value.mode === "background" ? "后台" : "前台"} · ${elapsed(value)} · `) +
          theme.fg("muted", oneLine(value.activity)) +
          (value.usage.totalTokens > 0 ? theme.fg("dim", " · " + usageText(value)) : ""));
      });
      return lines.map(line => truncateToWidth(line, width));
    },
  };
}

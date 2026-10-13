import type { AgentUsage } from "../model/agent.js";

export function emptyAgentUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addAgentUsage(target: AgentUsage, value: AgentUsage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += value[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += value.cost[key];
  for (const key of ["reasoning", "cacheWrite1h"] as const) if (value[key] !== undefined) target[key] = (target[key] ?? 0) + value[key];
}

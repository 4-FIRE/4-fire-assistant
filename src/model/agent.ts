export class AgentRef {
  declare conversationId: string;
  declare agent: string;
  declare file: string;
  declare leaf: string | null;
  constructor(value: AgentRef) { Object.assign(this, value); }
}
export interface AgentUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  reasoning?: number; cacheWrite1h?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export type AgentMode = "foreground" | "background";
export type SteeringStatus = "queued" | "handled";
export interface AgentAnswer { session: AgentRef; report: string; failed: boolean; usage: AgentUsage; error?: string }
export type AgentState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface AgentExecution {
  runId: string; agent: string; message: string; mode: AgentMode; state: AgentState;
  createdAt: number; startedAt?: number; finishedAt?: number; session?: AgentRef;
  activity: string; report: string; error?: string; usage: AgentUsage;
}
export interface AgentProgress { activity?: string; report?: string; session?: AgentRef; usage?: AgentUsage }

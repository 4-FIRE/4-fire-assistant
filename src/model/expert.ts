export class ExpertRef {
  declare id: string;
  declare role: "researcher" | "reviewer";
  declare file: string;
  constructor(value: ExpertRef) { Object.assign(this, value); }
}
export interface ExpertUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface ExpertAnswer { expert: ExpertRef; report: string; failed: boolean; usage: ExpertUsage }

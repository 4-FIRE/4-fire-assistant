import { requireThat } from "../common/validation.js";
import type { Params } from "../common/json.js";
import type { ExpertRef, ExpertAnswer } from "../model/expert.js";
import type { Receipt } from "../model/receipt.js";
import type { Scope } from "../model/execution-intent.js";
import type { SourceService } from "./source-service.js";
import type { ExecutionService } from "./execution-service.js";

export interface ReviewDecision { approved: boolean; evidenceIds: string[]; note: string }
export interface Delegation { role: ExpertRef["role"]; goal: string; expertId?: string; intentId?: string }
export interface ExpertTask {
  role: ExpertRef["role"];
  goal: string;
  previous: ExpertRef | undefined;
  remember(ref: ExpertRef): void;
  read(source: string, operation: string, parameters: Params, signal?: AbortSignal): Promise<Receipt>;
  submitReview: ((decision: ReviewDecision) => void) | undefined;
}
export type ExpertRun = (task: ExpertTask) => Promise<ExpertAnswer>;

export class ExpertService {
  constructor(private readonly sources: SourceService, private readonly execution: ExecutionService) {}
  prepare(input: Delegation, refs: ExpertRef[], scope: Scope, signal: AbortSignal): ExpertTask {
    signal.throwIfAborted();
    const generation = this.execution.generation;
    const previous = input.expertId ? refs.find(ref => ref.id === input.expertId) : undefined;
    requireThat(!input.expertId || previous, "该专家不属于当前分支。");
    requireThat(!previous || previous.role === input.role, "专家角色不匹配。");
    requireThat(input.role === "reviewer" ? input.intentId && !previous : !input.intentId, "复核需提供 intentId，并使用新的独立上下文。");
    const evidence = new Set<string>();
    let reviewerId: string | undefined;
    let goal = input.goal;
    let submitReview: ExpertTask["submitReview"];
    if (input.role === "reviewer") {
      const intent = this.execution.get(input.intentId!);
      requireThat(intent.state === "prepared" && intent.session === scope.session && intent.request === scope.request, "复核方案不属于当前请求。");
      goal += "\n\n核实以下精确调用。自己查询关键事实，不将主助手报告当作独立证据。通过 ffa_submit_review 登记决定。\n" + JSON.stringify(intent);
      submitReview = decision => {
        signal.throwIfAborted();
        requireThat(decision.evidenceIds.every(id => evidence.has(id)), "复核只能引用本专家取得的查询回执。");
        requireThat(reviewerId, "复核会话尚未建立。");
        this.execution.review(intent.id, scope, generation, reviewerId, decision.approved, decision.evidenceIds, decision.note);
      };
    }
    return {
      role: input.role, goal, previous,
      remember: ref => {
        signal.throwIfAborted();
        requireThat(generation === this.execution.generation, "专家调用所属请求已失效。");
        reviewerId = ref.id;
      },
      read: async (source, operation, parameters, callSignal) => {
        signal.throwIfAborted();
        const cancel = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        const receipt = await this.sources.read(source, operation, parameters, cancel);
        evidence.add(receipt.id); return receipt;
      },
      submitReview,
    };
  }
  async delegate(input: Delegation, refs: ExpertRef[], scope: Scope, run: ExpertRun, signal: AbortSignal) {
    const task = this.prepare(input, refs, scope, signal);
    try {
      const answer = await run(task);
      signal.throwIfAborted();
      if (answer.failed) this.execution.revoke();
      return answer;
    } catch (error) { this.execution.revoke(); throw error; }
  }
}

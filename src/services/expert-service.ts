import { requireThat } from "../common/validation.js";
import type { Params } from "../common/json.js";
import type { ExpertRef, ExpertAnswer } from "../model/expert.js";
import type { Intent, Scope } from "../model/execution-intent.js";
import type { ExecutionService } from "./execution-service.js";

export interface Delegation { role: ExpertRef["role"]; goal: string; expertId?: string }
export interface ExpertTask {
  role: ExpertRef["role"];
  goal: string;
  previous: ExpertRef | undefined;
  call(provider: string, operation: string, parameters: Params, confirm: (value: unknown) => Promise<boolean>, signal?: AbortSignal): Promise<Intent>;
}
export type ExpertRun = (task: ExpertTask) => Promise<ExpertAnswer>;

export class ExpertService {
  constructor(private readonly execution: ExecutionService) {}
  prepare(input: Delegation, refs: ExpertRef[], scope: Scope, signal: AbortSignal): ExpertTask {
    signal.throwIfAborted();
    const previous = input.expertId ? refs.find(ref => ref.id === input.expertId) : undefined;
    requireThat(!input.expertId || previous, "该专家不属于当前分支。");
    requireThat(!previous || previous.role === input.role, "专家角色不匹配。");
    requireThat(input.role !== "reviewer" || !previous, "方案复核使用新的独立上下文。");
    return {
      role: input.role, goal: input.goal, previous,
      call: (provider, operation, parameters, confirm, callSignal) => {
        signal.throwIfAborted();
        const cancel = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        return this.execution.call(scope, provider, operation, parameters, confirm, cancel);
      },
    };
  }
  async delegate(input: Delegation, refs: ExpertRef[], scope: Scope, run: ExpertRun, signal: AbortSignal) {
    const task = this.prepare(input, refs, scope, signal);
    const answer = await run(task); signal.throwIfAborted(); return answer;
  }
}

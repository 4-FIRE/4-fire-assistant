import { randomUUID } from "node:crypto";
import { requireThat } from "../../common/validation.js";
import type { Params } from "../../common/json.js";
import type { AgentRef, AgentAnswer, AgentExecution, AgentProgress, AgentMode, SteeringStatus } from "../../model/agent.js";
import type { Intent, Scope } from "../../model/execution-intent.js";
import type { ExecutionService } from "../execution/execution-service.js";
import { AgentQueue } from "./agent-queue.js";
import { addAgentUsage, emptyAgentUsage } from "./agent-usage.js";

export interface Delegation { agent: string; message: string; runId?: string; mode?: AgentMode }
export interface AgentTask {
  agent: string; message: string; previous: AgentRef | undefined;
  call(provider: string, operation: string, parameters: Params, confirm: (value: unknown, recheck: () => Promise<void>) => Promise<boolean>, signal?: AbortSignal): Promise<Intent>;
}
export type AgentRun = (task: AgentTask, signal: AbortSignal, progress: (value: AgentProgress) => void,
  control: (steer: (text: string) => Promise<SteeringStatus>) => void) => Promise<AgentAnswer>;
interface Run {
  value: AgentExecution; controller: AbortController; done: Promise<void>;
  steer?: (text: string) => Promise<SteeringStatus>; claimed: boolean; reported: boolean;
}

export class AgentService {
  readonly #queue = new AgentQueue();
  readonly #runs = new Map<string, Run>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  constructor(private readonly execution: ExecutionService) {}
  prepare(input: Delegation, runIds: Set<string>, scope: Scope, signal: AbortSignal): AgentTask {
    signal.throwIfAborted();
    const source = input.runId ? this.get(input.runId, runIds).value : undefined;
    if (source) this.requireFinished(source);
    const previous = source?.session;
    requireThat(!source || previous, "该执行没有可接续的会话检查点；请使用 action=start。");
    requireThat(!previous || previous.agent === input.agent, "专家职责不匹配。");
    requireThat(input.agent !== "reviewer" || !previous, "方案复核使用新的独立上下文；请使用 action=start、agent=reviewer。");
    if (previous) {
      const busy = [...this.#runs.values()].find(run => !run.value.finishedAt &&
        run.value.session?.conversationId === previous.conversationId);
      if (busy) this.requireFinished(busy.value);
    }
    return {
      agent: input.agent, message: input.message, previous: previous ? structuredClone(previous) : undefined,
      call: (provider, operation, parameters, confirm, callSignal) => {
        signal.throwIfAborted();
        const cancel = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        return this.execution.call(scope, provider, operation, parameters, confirm, cancel);
      },
    };
  }
  private requireFinished(value: AgentExecution) {
    const next = this.#runs.get(value.runId)?.steer ? "steer" : "wait";
    requireThat(value.finishedAt, `执行 ${value.runId} 尚未结束；${next === "steer" ? "追加信息" : "等待启动或完成"}请使用 ffa_agent action=${next}、runId=${value.runId}。`);
  }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  private changed() { for (const listener of this.#listeners) listener(); }
  start(input: Delegation, runIds: Set<string>, scope: Scope, run: AgentRun, signal: AbortSignal,
    save: (value: AgentExecution) => void): string {
    requireThat(!this.#closed, "专家服务已关闭。");
    const controller = new AbortController(), cancel = AbortSignal.any([signal, controller.signal]);
    const task = this.prepare(input, runIds, scope, cancel);
    const value: AgentExecution = { runId: randomUUID(), agent: input.agent, message: input.message, mode: input.mode ?? "foreground",
      state: "queued", createdAt: Date.now(), activity: "排队", report: "", usage: emptyAgentUsage(),
      ...(task.previous ? { session: structuredClone(task.previous) } : {}) };
    const record: Run = { value, controller, done: Promise.resolve(), claimed: value.mode !== "background", reported: false };
    this.#runs.set(value.runId, record);
    try { save(structuredClone(value)); } catch (error) { this.#runs.delete(value.runId); throw error; }
    record.done = this.#queue.run(async queuedSignal => {
      value.state = "running"; value.startedAt = Date.now(); value.activity = "启动"; this.changed();
      const answer = await run(task, queuedSignal, progress => {
        if (progress.activity !== undefined) value.activity = progress.activity;
        if (progress.report !== undefined) value.report = progress.report;
        if (progress.session !== undefined) value.session = structuredClone(progress.session);
        if (progress.usage !== undefined) value.usage = structuredClone(progress.usage);
        if (progress.session) save(structuredClone(value));
        this.changed();
      }, steer => { record.steer = steer; });
      Object.assign(value, { session: answer.session, report: answer.report, usage: answer.usage });
      if (answer.error !== undefined) value.error = answer.error;
      value.state = queuedSignal.aborted ? "cancelled" : answer.failed ? "failed" : "completed";
    }, cancel).catch(error => {
      value.state = cancel.aborted ? "cancelled" : "failed";
      value.error = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      value.finishedAt = Date.now(); value.activity = value.state; delete record.steer;
      try { save(structuredClone(value)); }
      catch (error) { value.state = "failed"; value.error = "专家记录保存失败：" + String(error); }
      this.changed();
    });
    this.changed();
    return value.runId;
  }
  restore(values: AgentExecution[], reported: Set<string>) {
    requireThat(!this.#closed, "专家服务已关闭。");
    for (const value of values) {
      if (this.#runs.has(value.runId)) continue;
      const restored = structuredClone(value);
      if (!restored.finishedAt) {
        restored.state = "interrupted"; restored.activity = "interrupted"; restored.finishedAt = Date.now();
      }
      this.#runs.set(value.runId, { value: restored, controller: new AbortController(), done: Promise.resolve(),
        claimed: true, reported: reported.has(value.runId) });
    }
  }
  list(runIds: Set<string>) { return [...this.#runs.values()].filter(run => runIds.has(run.value.runId)).map(run => structuredClone(run.value)); }
  private get(runId: string, runIds: Set<string>) {
    requireThat(runIds.has(runId) && this.#runs.has(runId), "该执行不属于当前分支。");
    return this.#runs.get(runId)!;
  }
  read(runId: string, runIds: Set<string>, claim = true) {
    const run = this.get(runId, runIds); if (claim && run.value.finishedAt) run.claimed = true;
    return structuredClone(run.value);
  }
  async wait(runId: string, runIds: Set<string>, signal: AbortSignal) {
    const run = this.get(runId, runIds); signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      void run.done.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
    });
    return this.read(runId, runIds);
  }
  stop(runId: string, runIds: Set<string>) { this.get(runId, runIds).controller.abort(); }
  async steer(runId: string, runIds: Set<string>, text: string) {
    const run = this.get(runId, runIds);
    requireThat(run.value.state === "running" && run.steer,
      `执行 ${runId} 尚不能接收补充信息；排队或启动时请等待，结束后使用 action=continue。`);
    return run.steer(text);
  }
  pending(runIds: Set<string>) {
    return this.list(runIds).filter(value => value.mode === "background" && value.finishedAt && !this.#runs.get(value.runId)!.claimed);
  }
  claim(runIds: string[]) { for (const runId of runIds) { const run = this.#runs.get(runId); if (run) run.claimed = true; } }
  usage(runIds: Set<string>) {
    const usage = emptyAgentUsage(), reported: string[] = [];
    for (const run of this.#runs.values()) {
      if (!runIds.has(run.value.runId) || !run.value.finishedAt || run.reported) continue;
      run.reported = true; reported.push(run.value.runId); addAgentUsage(usage, run.value.usage);
    }
    return { usage, runIds: reported };
  }
  reconcileUsage(reported: Set<string>) {
    for (const run of this.#runs.values()) if (run.value.finishedAt) run.reported = reported.has(run.value.runId);
  }
  cancelAll() { for (const run of this.#runs.values()) if (!run.value.finishedAt) run.controller.abort(); }
  async settle() { await Promise.allSettled([...this.#runs.values()].map(run => run.done)); }
  async reset() { this.cancelAll(); await this.settle(); this.#runs.clear(); }
  async close() {
    this.#closed = true; this.cancelAll();
    await this.#queue.close();
    await this.settle();
    this.#listeners.clear();
  }
}

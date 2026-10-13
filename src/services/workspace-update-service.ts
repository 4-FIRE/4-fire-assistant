import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { requireThat } from "../common/validation.js";
import { canonical } from "../common/json.js";
import type { DocumentChange, UpdateBatch, UpdateReport, UpdateStepPlan, WorkspaceUpdateState } from "../model/workspace-update.js";
import type { Store } from "../storage/store.js";
import { state } from "../storage/workspace-state.js";
import { backupUpdate, readUpdateState, saveUpdateState, updateFile } from "../storage/workspace-update.js";
import type { UpdateContext, WorkspaceUpgrade } from "./workspace-update-contract.js";
import { targetWorkspaceVersion, workspaceUpgrades } from "./upgrades/index.js";

export class WorkspaceUpdateService {
  readonly #controller = new AbortController();
  #pending: Promise<unknown> | undefined;
  // Authorization to resume comes only from this instance's explicit command.
  #enabled = false;
  constructor(private readonly root: string, private readonly store: Store,
    private readonly upgrades: readonly WorkspaceUpgrade[] = workspaceUpgrades,
    readonly target = targetWorkspaceVersion) {}
  private context(signal: AbortSignal): UpdateContext { return { root: this.root, store: this.store, signal }; }
  private async current() {
    requireThat(!this.#controller.signal.aborted && this.store.healthy, "工作区升级实例已关闭或存储不可写。");
    requireThat((await state(this.root))?.status === "ready", "请先执行 /ffa init 完成初始化。");
    return readUpdateState(this.store);
  }
  private chain(current: WorkspaceUpdateState) {
    requireThat(Number.isSafeInteger(this.target) && this.target >= 1 && current.version <= this.target, "工作区版本高于插件支持版本；不降级。");
    requireThat(!current.batch || current.batch.to <= this.target, "插件不支持未完成的升级阶段。");
    const chain: WorkspaceUpgrade[] = [];
    for (let from = current.version; from < this.target; from++) {
      const matches = this.upgrades.filter(upgrade => upgrade.from === from && upgrade.to === from + 1);
      requireThat(matches.length === 1, `缺少或重复升级脚本：${from}→${from + 1}。`);
      const upgrade = matches[0]!;
      requireThat(upgrade.summary.trim() && upgrade.instructions.trim(), `缺少升级说明：${from}→${from + 1}。`);
      chain.push(upgrade);
    }
    return chain;
  }
  async inspect() {
    const current = await this.current();
    this.chain(current);
    return { version: current.version, target: this.target, pending: !!current.batch, available: current.version < this.target };
  }
  private run<T>(signal: AbortSignal, work: (cancel: AbortSignal) => Promise<T>): Promise<T> {
    requireThat(!this.#pending && !this.#controller.signal.aborted, "工作区升级操作正在执行或实例已关闭。");
    const cancel = AbortSignal.any([signal, this.#controller.signal]);
    cancel.throwIfAborted();
    const pending = work(cancel).then(value => { cancel.throwIfAborted(); return value; })
      .finally(() => { this.#pending = undefined; });
    this.#pending = pending;
    return pending;
  }
  async close() { this.#enabled = false; this.#controller.abort(); await this.#pending?.catch(() => undefined); }
  private async instructions(upgrade: WorkspaceUpgrade) {
    let text: string;
    try { text = await readFile(upgrade.instructions, "utf8"); }
    catch (error) { throw new Error(`无法读取升级说明：${upgrade.from}→${upgrade.to}。`, { cause: error }); }
    requireThat(text.trim(), `升级说明为空：${upgrade.from}→${upgrade.to}。`);
    return text;
  }
  private async requirements(current: WorkspaceUpdateState, signal: AbortSignal) {
    const chain = this.chain(current);
    for (const [index, upgrade] of chain.entries()) {
      await this.instructions(upgrade);
      if (index === 0) await upgrade.preflight(this.context(signal));
      for (const path of upgrade.internalFiles) await updateFile(this.root, path, true);
      for (const path of upgrade.documents) await updateFile(this.root, path, false);
      signal.throwIfAborted();
    }
    return chain;
  }
  private async declaration(upgrade: WorkspaceUpgrade) {
    return { summary: upgrade.summary, instructions: await this.instructions(upgrade),
      internalFiles: [...upgrade.internalFiles], requiredDocuments: [...upgrade.documents] };
  }
  private async approved(batch: UpdateBatch, upgrade: WorkspaceUpgrade) {
    const latest = batch.plans.at(-1);
    if (!latest) return false;
    const { documents: _documents, ...declaration } = latest;
    return canonical(declaration) === canonical(await this.declaration(upgrade));
  }
  private async view(current: WorkspaceUpdateState, upgrade?: WorkspaceUpgrade) {
    const batch = current.batch;
    if (!batch || !upgrade) return { version: current.version, target: this.target, done: true };
    return { version: current.version, target: this.target, done: false, batch: batch.id, from: batch.from, to: batch.to,
      stage: batch.stage !== "planning" && !await this.approved(batch, upgrade) ? "planning" as const : batch.stage,
      summary: upgrade.summary, instructions: await this.instructions(upgrade),
      requiredDocuments: upgrade.documents, plans: batch.plans.map(plan => plan.documents),
      chain: await Promise.all(this.chain(current).map(async step => ({ from: step.from, to: step.to,
        summary: step.summary, instructions: await this.instructions(step), requiredDocuments: step.documents }))) };
  }
  /** No writes, backup or model task when the installed target is already met. */
  start(signal: AbortSignal) {
    return this.run(signal, async cancel => {
      const current = await this.current(), chain = await this.requirements(current, cancel);
      const upgrade = chain[0];
      if (!upgrade) return this.view(current);
      if (!current.batch) {
        const approval = current.approvals?.find(item => item.from === current.version);
        current.batch = { id: randomUUID(), from: current.version, to: current.version + 1,
          stage: approval ? "program" : "planning", plans: approval ? [approval.plan] : [] };
        if (current.approvals) current.approvals = current.approvals.filter(item => item.from !== current.version);
        cancel.throwIfAborted(); saveUpdateState(this.store, current);
      }
      this.#enabled = true;
      if (current.batch.stage !== "planning" && await this.approved(current.batch, upgrade)) await this.program(current, upgrade, cancel);
      return this.view(current, upgrade);
    });
  }
  resume(signal: AbortSignal) {
    requireThat(this.#enabled, "请先显式执行 /ffa update 开始或接续。");
    return this.start(signal);
  }
  private async active(id: string, from: number, signal: AbortSignal) {
    requireThat(this.#enabled, "请先显式执行 /ffa update 开始或接续。");
    const current = await this.current();
    requireThat(current.batch?.id === id && current.version === from, "升级批次或源版本已失效。");
    const upgrade = (await this.requirements(current, signal))[0]!;
    return { current, batch: current.batch, upgrade };
  }
  private async backups(batch: UpdateBatch, signal: AbortSignal) {
    const saved = new Set<string>();
    for (const [segment, plan] of batch.plans.entries()) {
      const documents = plan.documents.filter(item => !saved.has(item.path));
      const internalFiles = [...(segment === 0 ? [".ffa/workspace.json"] : []), ...plan.internalFiles]
        .filter(path => !saved.has(path));
      await backupUpdate(this.root, this.store, batch.id, batch.from, segment, [
        ...internalFiles.map(path => ({ path, internal: true })),
        ...documents.map(item => ({ path: item.path, internal: false })),
      ], signal);
      for (const item of plan.documents) saved.add(item.path);
      for (const path of internalFiles) saved.add(path);
    }
  }
  private async program(current: WorkspaceUpdateState, upgrade: WorkspaceUpgrade, signal: AbortSignal) {
    const batch = current.batch!;
    requireThat(await this.approved(batch, upgrade), "升级声明已变化；请重新提交方案并确认。");
    await this.backups(batch, signal);
    const context = this.context(signal);
    if (batch.stage === "documents") {
      requireThat(await upgrade.verify(context), "已完成的程序阶段验证失败；停止资料修改。");
      return;
    }
    // Detect saved effects even when their phase record was interrupted.
    if (!await upgrade.verify(context)) {
      signal.throwIfAborted(); await upgrade.apply(context);
    }
    requireThat(await upgrade.verify(context), "程序阶段验证失败；未进入资料修改阶段。");
    signal.throwIfAborted(); batch.stage = "documents"; saveUpdateState(this.store, current);
  }
  plan(id: string, from: number, input: DocumentChange[], confirm: (value: unknown, signal: AbortSignal) => Promise<boolean>,
    signal: AbortSignal, following: UpdateStepPlan[] = []) {
    // Detach the approved plan from caller-owned mutable input.
    const plan = input.map(item => ({ ...item }));
    const nextPlans = following.map(step => ({ from: step.from, documents: step.documents.map(item => ({ ...item })) }));
    return this.run(signal, async cancel => {
      const { current, batch, upgrade } = await this.active(id, from, cancel);
      requireThat(new Set(plan.map(item => item.path)).size === plan.length && plan.every(item => item.change.trim()), "需要明确且不重复的文件修改方案。");
      for (const item of plan) await updateFile(this.root, item.path, false);
      const paths = new Set([...batch.plans.flatMap(plan => plan.documents).map(item => item.path), ...plan.map(item => item.path)]);
      requireThat(upgrade.documents.every(path => paths.has(path)), "方案缺少必需资料；不开始升级。");
      const approvals: NonNullable<WorkspaceUpdateState["approvals"]> = [];
      requireThat(new Set(nextPlans.map(step => step.from)).size === nextPlans.length, "后续版本方案重复。");
      for (const step of nextPlans) {
        const next = this.chain(current).find(upgrade => upgrade.from === step.from && step.from > from);
        requireThat(next, "后续方案不属于当前升级链。");
        requireThat(new Set(step.documents.map(item => item.path)).size === step.documents.length &&
          step.documents.every(item => item.change.trim()) && next.documents.every(path => step.documents.some(item => item.path === path)), "后续版本方案缺少必需资料。");
        for (const item of step.documents) await updateFile(this.root, item.path, false);
        approvals.push({ from: step.from, plan: { documents: step.documents, ...await this.declaration(next) } });
      }
      const declaration = await this.declaration(upgrade);
      const changed = batch.plans.length > 0 && !await this.approved(batch, upgrade);
      requireThat(await confirm({ from, to: upgrade.to, summary: declaration.summary, documents: plan,
        previousPlans: batch.plans.map(plan => plan.documents), following: approvals.map(item => ({ from: item.from,
          summary: item.plan.summary, documents: item.plan.documents })) }, cancel), "用户未确认升级方案；未开始新变更。");
      cancel.throwIfAborted();
      const checked = await this.current();
      requireThat(checked.batch?.id === id && checked.version === from, "确认期间升级批次变化。");
      requireThat(canonical(declaration) === canonical(await this.declaration(upgrade)), "确认期间升级声明变化；请重新确认。");
      for (const approval of approvals) {
        const next = this.chain(current).find(step => step.from === approval.from)!;
        const { documents: _documents, ...approved } = approval.plan;
        requireThat(canonical(approved) === canonical(await this.declaration(next)), "确认期间后续版本声明变化。");
      }
      if (approvals.length) current.approvals = [...(current.approvals ?? []).filter(item => !approvals.some(next => next.from === item.from)), ...approvals];
      batch.plans.push({ documents: plan, ...declaration });
      if (batch.stage === "planning" || changed) batch.stage = "program";
      saveUpdateState(this.store, current);
      await this.program(current, upgrade, cancel);
      return this.view(current, upgrade);
    });
  }
  complete(id: string, from: number, input: UpdateReport, confirm: (value: unknown, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal) {
    const report = { modified: [...input.modified], unchanged: [...input.unchanged], unresolved: [...input.unresolved] };
    return this.run(signal, async cancel => {
      const { current, batch, upgrade } = await this.active(id, from, cancel);
      requireThat(batch.stage === "documents", "程序阶段尚未完成。");
      const paths = [...new Set(batch.plans.flatMap(plan => plan.documents).map(item => item.path))];
      const reported = [...report.modified, ...report.unchanged];
      requireThat(!report.unresolved.length && new Set(reported).size === reported.length &&
        paths.every(path => reported.includes(path)) && reported.every(path => paths.includes(path)), "升级报告有未解决项、缺项或未确认范围。");
      const validate = async () => {
        requireThat(await this.approved(batch, upgrade), "升级声明已变化；请重新提交方案并确认。");
        await this.backups(batch, cancel);
        requireThat(await upgrade.verify(this.context(cancel)), "程序阶段验证失败。");
        for (const path of upgrade.documents) requireThat((await readFile(await updateFile(this.root, path, false), "utf8")).trim(), "必需资料为空：" + path);
        await upgrade.validateDocuments(this.context(cancel));
        cancel.throwIfAborted();
      };
      await validate();
      requireThat(await confirm({ from, to: upgrade.to, summary: upgrade.summary, report }, cancel), "用户未确认该版升级完成。");
      await validate();
      const checked = await this.current();
      requireThat(checked.batch?.id === id && checked.version === from, "确认期间升级批次变化。");
      cancel.throwIfAborted();
      this.store.transaction(() => {
        this.store.put("workspace-update-history", id, { ...batch, report, completedAt: new Date().toISOString() });
        saveUpdateState(this.store, { version: batch.to, ...(current.approvals ? { approvals: current.approvals } : {}) });
      });
      // Only after this commit can the next version start.
      return { version: batch.to, target: this.target, done: batch.to === this.target };
    });
  }
}

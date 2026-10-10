import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  Harness, LiveDoc, configure, createRegistry, defineDoc,
  type Conversation, type ConversationId, type ConversationView,
  type Submission, type HarnessSettings, type LiveState,
} from "@earendil-works/pi-durable";
import {
  AssistantError, type CommittedView, type ConversationSummary, type ModelSelection,
  type RunResult, type RuntimePort, type RuntimeStatus, type TranscriptMessage, type WorkSummary,
} from "../application/ports.js";
import { openApplicationStorage, type ApplicationStorage } from "./storage.js";
import { requireModel } from "./models.js";
import { resourceText } from "./resources.js";
import { BusinessIntegration, type BusinessOptions } from "./business.js";
import { TeamDoc, WorkDoc, json, type StoredRequest } from "./business-documents.js";
import type { Scope } from "../domain/shared.js";

type StoredSession = { id: ConversationId; title: string };
type Workspace = { activeId: ConversationId | null; sessions: StoredSession[] };
const WorkspaceDoc = defineDoc<Workspace>({
  kind: "fire.workspace", version: 1, scope: "session",
  initial: () => ({ activeId: null, sessions: [] }),
});
const pending = (request: WorkSummary | null | undefined) =>
  request?.status === "running" || request?.status === "admitting";
const summary = (session: StoredSession): ConversationSummary => ({ id: String(session.id), title: session.title });
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}
function currentActivity(live: LiveState | undefined, partial: string): string {
  const tools = live?.tools?.filter(tool => tool.status === "running") ?? [];
  if (tools.length) return `执行工具：${tools.map(tool => tool.name).join("、")}`;
  if (live?.compactions?.some(compaction => compaction.blocking)) return "整理上下文";
  if (live?.generation?.retry) return "等待模型重试";
  if (live?.generation?.message?.content.some(part => part.type === "thinking") && !partial.trim()) return "模型思考中";
  if (live?.generation) return partial.trim() ? "正在回答" : "等待模型回复";
  const pendingTools = live?.tools?.filter(tool => tool.status === "pending") ?? [];
  if (pendingTools.length) return `等待工具：${pendingTools.map(tool => tool.name).join("、")}`;
  return "正在处理";
}
function committedView(session: StoredSession, view: ConversationView): CommittedView {
  const messages: TranscriptMessage[] = [];
  for (const entry of view.entries) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      if (message.role === "user" || message.role === "assistant") {
        messages.push({ id: `${entry.id}:${index}`, role: message.role, text: messageText(message) });
      }
    }
  }
  const live = view.docs["pi.live"] as LiveState | undefined;
  const partial = live?.generation?.message ? messageText(live.generation.message) : "";
  return { conversation: summary(session), messages,
    partial, activity: currentActivity(live, partial),
    working: live?.run !== undefined };
}

/** SDK-specific task/submission/transaction details remain inside this adapter. */
export class DurableRuntime implements RuntimePort {
  readonly #harness: Harness;
  readonly #storage: ApplicationStorage;
  readonly #model: ModelSelection;
  readonly #business: BusinessIntegration | undefined;
  #activeRequest: string | null = null;
  #current: StoredSession;
  #operations: Promise<unknown> = Promise.resolve();
  #inProcess = new Set<string>();
  #cancelEpoch = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #watches = new Set<() => Promise<void>>();

  private constructor(harness: Harness, storage: ApplicationStorage,
    current: StoredSession, model: ModelSelection, business?: BusinessIntegration) {
    this.#harness = harness;
    this.#storage = storage;
    this.#current = current;
    this.#model = structuredClone(model);
    this.#business = business;
    business?.bind(harness, (scope: Scope) => !this.#closing && scope.ownerId === this.#current.id && scope.requestId === this.#activeRequest);
  }
  static async open(options: { directory: string; models: Models; model: ModelSelection; storage?: ApplicationStorage; business?: BusinessOptions; settings?: HarnessSettings }): Promise<DurableRuntime> {
    requireModel(options.models, options.model);
    const storage = options.storage ?? await openApplicationStorage(options.directory);
    let harness: Harness | undefined;
    try {
      const registry = createRegistry();
      const business = options.business ? await BusinessIntegration.create({ ...options.business, workingDirectory: storage.directory }, options.model) : undefined;
      if (business) registry.install(business.extension);
      harness = await Harness.open(storage.storage, { models: options.models, registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? storage.directory, shellEnv: { LANG: "C.UTF-8" } }),
        ...(options.settings ? { settings: options.settings } : {}) }, context);
      const root = await harness.root(context, { agent: business?.agent("coordinator") ?? {
        model: options.model, tools: [], extensions: [], instructions: resourceText("prompts/runtime/foundation.md").trimEnd(),
      }, init: async (tx, id) => { await tx.doc(WorkDoc, id); } });
      const active = await harness.commit(async tx => {
        const workspace = await tx.doc(WorkspaceDoc);
        if (workspace.sessions.length === 0) {
          workspace.sessions.push({ id: root.id, title: "主会话" });
          workspace.activeId = root.id;
        }
        const session = workspace.sessions.find(item => item.id === workspace.activeId);
        if (!session) throw new AssistantError("WORKSPACE_INVALID", "当前会话索引无效；记录未删除。");
        return { ...session };
      }, context);
      const runtime = new DurableRuntime(harness, storage, active, options.model, business);
      await business?.recover();
      const conversation = await runtime.conversation();
      const work = await harness.snapshot(WorkDoc, conversation.id, context);
      const agent = await conversation.agent(context);
      if (pending(work?.request) && agent.model &&
          (agent.model.provider !== options.model.provider || agent.model.modelId !== options.model.modelId)) {
        throw new AssistantError("PENDING_MODEL_CHANGE", "未完成工作仍绑定原模型；请先用原模型恢复或取消。");
      }
      if (!pending(work?.request)) await conversation.configure(business?.agent("coordinator") ?? { model: options.model }, context);
      // Opening and inspection do not enable SDK scheduling.
      return runtime;
    } catch (error) {
      if (harness) await harness.close(context);
      await storage.close();
      throw error;
    }
  }
  private checkOpen() {
    if (this.#closing) throw new AssistantError("RUNTIME_CLOSED", "运行时已关闭；未完成工作可在重开后恢复。");
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(() => { this.checkOpen(); return operation(); });
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private async conversation(): Promise<Conversation> {
    const found = await this.#harness.conversation(this.#current.id, context);
    if (!found) throw new AssistantError("CONVERSATION_MISSING", "已登记会话不存在；不能以新会话替代。");
    return found;
  }
  async status(): Promise<RuntimeStatus> {
    this.checkOpen();
    const work = await this.#harness.snapshot(WorkDoc, this.#current.id, context);
    const inspection = await this.#harness.inspect(context);
    const request = work?.request ?? null;
    const blocked: string[] = inspection.tasks.flatMap(task => task.state.kind === "blocked" ? [task.state.reason] : []);
    const team = await this.#harness.snapshot(TeamDoc, this.#current.id, context);
    const unassociated = inspection.submissions.some(submission => {
      if (submission.conversationId === this.#current.id) {
        return !pending(request) || submission.requestId !== request!.requestId;
      }
      if (!team?.experts.some(expert => expert.conversationId === submission.conversationId)) return false;
      return !pending(request) || !team.delegations.some(delegation =>
        delegation.conversationId === submission.conversationId && delegation.requestId === submission.requestId &&
        delegation.ownerRequestId === request!.requestId);
    });
    if (unassociated) blocked.push("work_association_missing");
    return {
      conversation: summary(this.#current),
      work: request ? { requestId: request.requestId, status: request.status, content: request.content } : null,
      needsContinuation: pending(request) && !this.#inProcess.has(request!.requestId),
      blocked, unfinishedTasks: inspection.tasks.length,
      ...(this.#business ? { business: await this.#business.status() } : {}),
      usage: json(await this.#harness.usage(context)),
    };
  }
  async sessions(): Promise<readonly ConversationSummary[]> {
    this.checkOpen();
    return ((await this.#harness.snapshot(WorkspaceDoc, context))?.sessions ?? []).map(summary);
  }
  private assertRecoverable(status: RuntimeStatus): void {
    if (status.blocked.includes("work_association_missing")) {
      throw new AssistantError("RECOVERY_BLOCKED", "当前主会话或专家存在未关联有效请求的输入；请先 /cancel 取消残留工作。记录和外部订单会保留。");
    }
    if (status.blocked.length) throw new AssistantError("RECOVERY_BLOCKED", `任务定义存在恢复阻塞：${status.blocked.join("、")}；请检查扩展及版本，记录未修改。`);
  }
  private async assertIdle(): Promise<void> {
    const status = await this.status();
    this.assertRecoverable(status);
    const live = await this.#harness.snapshot(LiveDoc, this.#current.id, context);
    if (pending(status.work) || live?.run || this.#inProcess.size > 0) {
      throw new AssistantError("WORK_BUSY", "请等待当前请求，或先 /cancel；重开后的未完成工作使用 /continue。");
    }
  }
  async submit(content: string): Promise<RunResult> {
    if (!content.trim()) throw new AssistantError("EMPTY_INPUT", "请输入具体目标。");
    const epoch = this.#cancelEpoch;
    const admission = await this.serialize(async () => {
      await this.assertIdle();
      const conversation = await this.conversation();
      const request: StoredRequest = { requestId: randomUUID(), content, submissionId: null, status: "admitting" };
      await conversation.commit(async tx => { (await tx.doc(WorkDoc, conversation.id)).request = request; }, context);
      if (epoch !== this.#cancelEpoch) {
        await conversation.commit(async tx => { (await tx.doc(WorkDoc, conversation.id)).request!.status = "cancelled"; }, context);
        throw new AssistantError("REQUEST_CANCELLED", "该输入在投递前已取消。");
      }
      this.#activeRequest = request.requestId;
      const submission = await this.admit(conversation, request);
      return { conversation, request, submission };
    });
    return this.finish(admission.conversation, admission.request, admission.submission);
  }
  private async admit(conversation: Conversation, request: StoredRequest): Promise<Submission> {
    const submission = await conversation.submit({ type: "input", content: request.content,
      requestId: request.requestId, whenBusy: "reject" }, context);
    await conversation.commit(async tx => {
      const current = (await tx.doc(WorkDoc, conversation.id)).request;
      if (current?.requestId === request.requestId) {
        current.submissionId = submission.id;
        current.status = "running";
      }
    }, context);
    this.#inProcess.add(request.requestId);
    return submission;
  }
  async continueWork(): Promise<RunResult> {
    const admission = await this.serialize(async () => {
      const status = await this.status();
      this.assertRecoverable(status);
      if (!status.needsContinuation) throw new AssistantError("NOTHING_TO_CONTINUE", "没有等待恢复的请求。");
      const conversation = await this.conversation();
      const request = (await this.#harness.snapshot(WorkDoc, conversation.id, context))!.request!;
      this.#activeRequest = request.requestId;
      // Even if admission succeeded before a crash but its ID was not recorded,
      // the stable requestId finds the original submission.
      const submission = request.submissionId === null ? await this.admit(conversation, request) :
        await this.#harness.submission(request.submissionId, context);
      if (!submission) throw new AssistantError("SUBMISSION_MISSING", "已登记输入不存在；不能重复生成替代输入。");
      this.#inProcess.add(request.requestId);
      return { conversation, request, submission };
    });
    return this.finish(admission.conversation, admission.request, admission.submission);
  }
  private async finish(conversation: Conversation, request: StoredRequest, submission: Submission): Promise<RunResult> {
    try {
      const settled = await submission.wait(context);
      const status: RunResult["status"] = settled.status === "done" ? "answered" :
        settled.reason === "aborted" ? "cancelled" : "unanswered";
      const effective = await this.serialize(async () => {
        return conversation.commit(async tx => {
          const work = await tx.doc(WorkDoc, conversation.id);
          if (work.request?.requestId === request.requestId) {
            if (work.request.status === "cancelled") return "cancelled" as const;
            work.request.status = status;
          }
          return status;
        }, context);
      });
      return { requestId: request.requestId, status: effective };
    } catch (error) {
      if (this.#closing) throw new AssistantError("WORK_PAUSED", "运行时已关闭，未完成工作保留用于恢复。");
      throw error;
    } finally {
      this.#inProcess.delete(request.requestId);
      if (this.#activeRequest === request.requestId) { this.#activeRequest = null; this.#business?.revoke(); }
    }
  }
  async cancel(): Promise<void> {
    // Synchronous latch closes the admission/cancel race; business tool entries
    // also check the request's cancelled state before starting work or dispatch.
    this.#activeRequest = null;
    this.#business?.revoke();
    this.#cancelEpoch++;
    await this.serialize(async () => {
      const conversation = await this.conversation();
      await conversation.commit(async tx => {
        const work = await tx.doc(WorkDoc, conversation.id);
        if (pending(work.request)) work.request!.status = "cancelled";
      }, context);
      await conversation.abort(context, { background: true });
    });
  }
  async newSession(title = "新会话"): Promise<ConversationSummary> {
    return this.serialize(async () => {
      await this.assertIdle();
      const created = await this.#harness.commit(async tx => {
        const workspace = await tx.doc(WorkspaceDoc);
        const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, child.id, this.#business?.agent("coordinator") ?? { model: this.#model, tools: [], extensions: [], instructions: resourceText("prompts/runtime/foundation.md").trimEnd() });
        await tx.doc(WorkDoc, child.id);
        const session = { id: child.id, title: title.trim() || "新会话" };
        workspace.sessions.push(session);
        workspace.activeId = child.id;
        return session;
      }, context);
      this.#current = created;
      return summary(created);
    });
  }
  async selectSession(id: string): Promise<ConversationSummary> {
    return this.serialize(async () => {
      await this.assertIdle();
      const selected = await this.#harness.commit(async tx => {
        const workspace = await tx.doc(WorkspaceDoc);
        const selected = workspace.sessions.find(session => String(session.id) === id);
        if (!selected) throw new AssistantError("SESSION_UNAVAILABLE", "该主会话不存在。");
        workspace.activeId = selected.id;
        return { ...selected };
      }, context);
      this.#current = selected;
      const conversation = await this.conversation();
      await conversation.configure(this.#business?.agent("coordinator") ?? { model: this.#model }, context);
      return summary(selected);
    });
  }
  async observe(listener: (view: CommittedView) => void | Promise<void>): Promise<() => Promise<void>> {
    this.checkOpen();
    const session = { ...this.#current };
    const watch = await (await this.conversation()).watch(context);
    try { await listener(committedView(session, watch.value)); }
    catch (error) { await watch.stop(); throw error; }
    watch.start(async value => { await listener(committedView(session, value)); });
    const stop = async () => { await watch.stop(); this.#watches.delete(stop); };
    this.#watches.add(stop);
    return stop;
  }
  async experts() { this.checkOpen(); return this.#business?.experts(this.#current.id) ?? []; }
  async intents() { this.checkOpen(); return this.#business?.intents(this.#current.id) ?? []; }
  async resolveIntent(id: string, revision: number, note: string) {
    return this.serialize(async () => {
      await this.assertIdle();
      if (!this.#business) throw new AssistantError("BUSINESS_UNAVAILABLE", "当前会话没有业务工具。");
      return this.#business.resolve(this.#current.id, id, revision, note);
    });
  }
  revoke(): void { this.checkOpen(); this.#business?.revoke(); }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#activeRequest = null;
    this.#business?.revoke();
    this.#closePromise = (async () => {
      await this.#operations;
      await Promise.all([...this.#watches].map(stop => stop()));
      await this.#harness.close(context);
      await this.#storage.close();
    })();
    return this.#closePromise;
  }
}

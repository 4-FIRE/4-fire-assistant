import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  Harness, LiveDoc, configure, createRegistry, createSession, defineDoc,
  type Conversation, type ConversationId, type ConversationView,
  type Submission, type HarnessSettings, type LiveState, type Session, type Tx,
} from "@earendil-works/pi-durable";
import {
  AssistantError, type CommittedView, type ConversationSummary, type ModelSelection,
  type RunResult, type RuntimePort, type RuntimeStatus, type SessionSummary, type TranscriptMessage, type WorkSummary,
} from "../application/ports.js";
import { openApplicationStorage, type ApplicationStorage } from "./storage.js";
import { requireModel } from "./model-runtime.js";
import { resourceText } from "./resources.js";
import { BusinessIntegration, type BusinessOptions } from "./assistant-integration.js";
import { TeamDoc, WorkDoc, json, type StoredRequest } from "./runtime-documents.js";
import { object, type Scope } from "../domain/shared.js";

type StoredSession = { id: ConversationId; uuid: string; title: string; createdAt: string | null; updatedAt: string | null };
type Workspace = { activeId: ConversationId | null; sessions: StoredSession[] };
export const WorkspaceDoc = defineDoc<Workspace>({
  kind: "fire.workspace", version: 2, scope: "session",
  initial: () => ({ activeId: null, sessions: [] }),
  migrate: (value, fromVersion) => {
    if (fromVersion !== 1 || !Array.isArray(value.sessions) ||
        value.sessions.some(item => !object(item) || !Number.isSafeInteger(item.id) || typeof item.title !== "string")) {
      throw new AssistantError("SESSION_INDEX_INVALID", "会话索引结构无效。索引未升级，请保留工作区并检查备份。");
    }
    const sessions = value.sessions as { id: ConversationId; title: string }[];
    if (new Set(sessions.map(item => item.id)).size !== sessions.length ||
        (sessions.length ? !sessions.some(item => item.id === value.activeId) : value.activeId !== null)) {
      throw new AssistantError("SESSION_INDEX_INVALID", "当前会话或会话编号无效。索引未升级，请保留工作区并检查备份。");
    }
    return { activeId: value.activeId as ConversationId | null, sessions: sessions.map(item => ({
      ...item, uuid: randomUUID(), createdAt: null, updatedAt: null,
    })) };
  },
});
/** Persist migrated UUIDs before any caller observes them. The instance lock is already held. */
async function ensureSessionIndex(session: Session, storage: ApplicationStorage): Promise<boolean> {
  const record = await storage.storage.findDocument({ kind: "fire.workspace", scope: { kind: "session" } }, "current", context);
  if (!record) return false;
  const stored = await storage.storage.document(record.id, "current", context);
  if (!stored) throw new AssistantError("SESSION_INDEX_INVALID", "无法读取会话索引。请保留工作区并检查备份。");
  if (stored.version !== 1 && stored.version !== 2) {
    throw new AssistantError("SESSION_INDEX_VERSION", "不支持此会话索引版本。请使用与工作区版本匹配的 FFA，不要删除工作区。");
  }
  if (stored.version === WorkspaceDoc.definition.version) return false;
  await session.commit(async tx => {
    const workspace = await tx.doc(WorkspaceDoc);
    for (const item of workspace.sessions) {
      if (!await tx.conversation(item.id)) throw new AssistantError("SESSION_INDEX_INVALID", "索引引用的会话不存在。索引未升级，请保留工作区并检查备份。");
    }
  }, context);
  return true;
}
const pending = (request: WorkSummary | null | undefined) =>
  request?.status === "running" || request?.status === "admitting";
const summary = (session: StoredSession): ConversationSummary => ({ id: session.uuid, title: session.title });
const sessionSummary = (session: StoredSession): SessionSummary => ({
  ...summary(session), createdAt: session.createdAt, updatedAt: session.updatedAt,
});
function newStoredSession(id: ConversationId, title: string): StoredSession {
  const now = new Date().toISOString();
  return { id, uuid: randomUUID(), title, createdAt: now, updatedAt: now };
}
async function touchSession(tx: Tx, id: ConversationId): Promise<void> {
  const session = (await tx.doc(WorkspaceDoc)).sessions.find(item => item.id === id);
  if (!session) throw new AssistantError("SESSION_UNAVAILABLE", "此主会话不存在。");
  session.updatedAt = new Date().toISOString();
}
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}
function currentActivity(live: LiveState | undefined, partial: string): string {
  const tools = live?.tools?.filter(tool => tool.status === "running") ?? [];
  if (tools.length) return `正在执行工具：${tools.map(tool => tool.name).join("、")}`;
  if (live?.compactions?.some(compaction => compaction.blocking)) return "正在整理上下文";
  if (live?.generation?.retry) return "正在等待模型重试";
  if (live?.generation?.message?.content.some(part => part.type === "thinking") && !partial.trim()) return "模型正在思考";
  if (live?.generation) return partial.trim() ? "正在回答" : "正在等待模型回答";
  const pendingTools = live?.tools?.filter(tool => tool.status === "pending") ?? [];
  if (pendingTools.length) return `正在等待工具：${pendingTools.map(tool => tool.name).join("、")}`;
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
  static async upgradeWorkspace(storage: ApplicationStorage): Promise<{ upgraded: boolean }> {
    const session = createSession(storage.storage);
    try { return { upgraded: await ensureSessionIndex(session, storage) }; }
    finally { await session.close(context); }
  }
  static async listSessions(storage: ApplicationStorage): Promise<readonly SessionSummary[]> {
    const session = createSession(storage.storage);
    try {
      await ensureSessionIndex(session, storage);
      return ((await session.snapshot(WorkspaceDoc, context))?.sessions ?? []).map(sessionSummary);
    } finally { await session.close(context); }
  }
  static async open(options: { directory: string; models: Models; model: ModelSelection; storage?: ApplicationStorage; business?: BusinessOptions; settings?: HarnessSettings; session?: "new" | { id: string } }): Promise<DurableRuntime> {
    requireModel(options.models, options.model);
    const storage = options.storage ?? await openApplicationStorage(options.directory);
    let harness: Harness | undefined;
    try {
      const registry = createRegistry();
      const business = options.business ? await BusinessIntegration.create({ ...options.business, workingDirectory: options.business.workingDirectory ?? options.business.resources?.directory ?? storage.directory }, options.model) : undefined;
      if (business) registry.install(business.extension);
      harness = await Harness.open(storage.storage, { models: options.models, registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? storage.directory, shellEnv: { LANG: "C.UTF-8" } }),
        ...(options.settings ? { settings: options.settings } : {}) }, context);
      await ensureSessionIndex(harness, storage);
      const existing = await harness.snapshot(WorkspaceDoc, context);
      const startupSession = options.session;
      if (typeof startupSession === "object" && !existing?.sessions.some(item => item.uuid === startupSession.id)) {
        throw new AssistantError("SESSION_UNAVAILABLE", "此主会话不存在。");
      }
      const root = await harness.root(context, { agent: business?.agent("coordinator") ?? {
        model: options.model, tools: [], extensions: [], instructions: resourceText("prompts/runtime/foundation.md").trimEnd(),
      }, init: async (tx, id) => { await tx.doc(WorkDoc, id); } });
      const active = await harness.commit(async tx => {
        const workspace = await tx.doc(WorkspaceDoc);
        if (workspace.sessions.length === 0) {
          workspace.sessions.push(newStoredSession(root.id, "主会话"));
          workspace.activeId = root.id;
        }
        const session = workspace.sessions.find(item => item.id === workspace.activeId);
        if (!session) throw new AssistantError("WORKSPACE_INVALID", "当前会话索引无效。记录未删除。");
        return { ...session };
      }, context);
      const runtime = new DurableRuntime(harness, storage, active, options.model, business);
      await business?.recover();
      if (options.session === "new" && existing?.sessions.length) await runtime.createNewSession();
      else if (typeof options.session === "object") await runtime.activateSession(options.session.id);
      else await runtime.configureConversation(await runtime.conversation());
      // Opening and inspection do not enable SDK scheduling.
      return runtime;
    } catch (error) {
      if (harness) await harness.close(context);
      await storage.close();
      throw error;
    }
  }
  private checkOpen() {
    if (this.#closing) throw new AssistantError("RUNTIME_CLOSED", "应用已停止运行。重新启动后，可恢复未完成的工作。");
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(() => { this.checkOpen(); return operation(); });
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
  private async configureConversation(conversation: Conversation): Promise<void> {
    const work = await this.#harness.snapshot(WorkDoc, conversation.id, context);
    if (pending(work?.request)) {
      const agent = await conversation.agent(context);
      if (agent.model && (agent.model.provider !== this.#model.provider || agent.model.modelId !== this.#model.modelId)) {
        throw new AssistantError("PENDING_MODEL_CHANGE", "未完成的工作仍使用原模型。请先用原模型恢复或取消该工作。");
      }
      return;
    }
    await conversation.configure(this.#business?.agent("coordinator") ?? { model: this.#model }, context);
  }
  private async conversation(id = this.#current.id): Promise<Conversation> {
    const found = await this.#harness.conversation(id, context);
    if (!found) throw new AssistantError("CONVERSATION_MISSING", "找不到已登记的会话。程序不会创建新会话来代替。");
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
    const workspace = await this.#harness.snapshot(WorkspaceDoc, context);
    const otherPendingSessions: RuntimeStatus["otherPendingSessions"][number][] = [];
    for (const session of workspace?.sessions ?? []) {
      if (session.id === this.#current.id) continue;
      const request = (await this.#harness.snapshot(WorkDoc, session.id, context))?.request;
      if (pending(request)) otherPendingSessions.push({ conversation: summary(session),
        work: { requestId: request!.requestId, status: request!.status, content: request!.content } });
    }
    return {
      conversation: summary(this.#current),
      work: request ? { requestId: request.requestId, status: request.status, content: request.content } : null,
      needsContinuation: pending(request) && !this.#inProcess.has(request!.requestId),
      otherPendingSessions,
      blocked, unfinishedTasks: inspection.tasks.length,
      ...(this.#business ? { business: await this.#business.status() } : {}),
      usage: json(await this.#harness.usage(context)),
    };
  }
  async sessions(): Promise<readonly SessionSummary[]> {
    this.checkOpen();
    return ((await this.#harness.snapshot(WorkspaceDoc, context))?.sessions ?? []).map(sessionSummary);
  }
  private assertRecoverable(status: RuntimeStatus): void {
    if (status.blocked.includes("work_association_missing")) {
      throw new AssistantError("RECOVERY_BLOCKED", "当前主会话或专家任务中有输入未关联有效请求。请先用 /cancel 取消剩余工作。记录和已发送的订单会保留。");
    }
    if (status.blocked.length) throw new AssistantError("RECOVERY_BLOCKED", `任务无法恢复：${status.blocked.join("、")}。请检查扩展及其版本。记录未修改。`);
  }
  private async assertIdle(): Promise<void> {
    const status = await this.status();
    this.assertRecoverable(status);
    const live = await this.#harness.snapshot(LiveDoc, this.#current.id, context);
    if (pending(status.work) || live?.run || this.#inProcess.size > 0) {
      throw new AssistantError("WORK_BUSY", "请等待当前请求完成，或用 /cancel 取消。重新启动后，用 --resume 或 --session 打开原会话，再确认恢复未完成的工作。");
    }
  }
  async submit(content: string): Promise<RunResult> {
    if (!content.trim()) throw new AssistantError("EMPTY_INPUT", "请输入具体目标。");
    const epoch = this.#cancelEpoch;
    const admission = await this.serialize(async () => {
      await this.assertIdle();
      await this.assertSchedulingScope();
      await this.#business?.refreshResources();
      const conversation = await this.conversation();
      await this.configureConversation(conversation);
      const request: StoredRequest = { requestId: randomUUID(), content, submissionId: null, status: "admitting" };
      await conversation.commit(async tx => {
        (await tx.doc(WorkDoc, conversation.id)).request = request;
        await touchSession(tx, conversation.id);
      }, context);
      if (epoch !== this.#cancelEpoch) {
        await conversation.commit(async tx => {
          (await tx.doc(WorkDoc, conversation.id)).request!.status = "cancelled";
          await touchSession(tx, conversation.id);
        }, context);
        throw new AssistantError("REQUEST_CANCELLED", "此输入在提交前已取消。");
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
        await touchSession(tx, conversation.id);
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
      await this.assertSchedulingScope();
      const conversation = await this.conversation();
      const request = (await this.#harness.snapshot(WorkDoc, conversation.id, context))!.request!;
      await this.#business?.refreshResources();
      if (this.#business) {
        await conversation.configure(this.#business.agent("coordinator"), context);
        const team = await this.#harness.snapshot(TeamDoc, conversation.id, context);
        for (const expert of team?.experts ?? []) {
          if (expert.active) await (await this.conversation(expert.conversationId)).configure(this.#business.agent(expert.role), context);
        }
      }
      this.#activeRequest = request.requestId;
      // Even if admission succeeded before a crash but its ID was not recorded,
      // the stable requestId finds the original submission.
      const submission = request.submissionId === null ? await this.admit(conversation, request) :
        await this.#harness.submission(request.submissionId, context);
      if (!submission) throw new AssistantError("SUBMISSION_MISSING", "找不到已登记的输入。程序不会重复生成输入来代替。");
      await conversation.commit(tx => touchSession(tx, conversation.id), context);
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
            await touchSession(tx, conversation.id);
          }
          return status;
        }, context);
      });
      return { requestId: request.requestId, status: effective };
    } catch (error) {
      if (this.#closing) throw new AssistantError("WORK_PAUSED", "应用已停止运行。未完成的工作已保留，可在重新启动后恢复。");
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
      await this.assertSchedulingScope();
      const conversation = await this.conversation();
      await conversation.commit(async tx => {
        const work = await tx.doc(WorkDoc, conversation.id);
        if (pending(work.request)) {
          work.request!.status = "cancelled";
          await touchSession(tx, conversation.id);
        }
      }, context);
      await conversation.abort(context, { background: true });
    });
  }
  /** The SDK resumes all live tasks together. Do not resume another session without consent. */
  private async assertSchedulingScope(): Promise<void> {
    const team = await this.#harness.snapshot(TeamDoc, this.#current.id, context);
    const allowed = new Set([this.#current.id, ...(team?.experts.map(expert => expert.conversationId) ?? [])]);
    const inspection = await this.#harness.inspect(context);
    if (inspection.tasks.some(task => task.record.conversationId === null || !allowed.has(task.record.conversationId)) ||
        inspection.submissions.some(submission => !allowed.has(submission.conversationId))) {
      throw new AssistantError("OTHER_SESSION_PENDING", "其他会话有未完成的运行。请用 --resume 或 --session 打开该会话，先恢复或取消。当前操作未启动，原记录保留。");
    }
  }
  private async createNewSession(title = "新会话"): Promise<ConversationSummary> {
    const created = await this.#harness.commit(async tx => {
      const workspace = await tx.doc(WorkspaceDoc);
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, child.id, this.#business?.agent("coordinator") ?? { model: this.#model, tools: [], extensions: [], instructions: resourceText("prompts/runtime/foundation.md").trimEnd() });
      await tx.doc(WorkDoc, child.id);
      const session = newStoredSession(child.id, title.trim() || "新会话");
      workspace.sessions.push(session);
      workspace.activeId = child.id;
      return session;
    }, context);
    this.#current = created;
    return summary(created);
  }
  async newSession(title = "新会话"): Promise<ConversationSummary> {
    return this.serialize(async () => {
      await this.assertIdle();
      return this.createNewSession(title);
    });
  }
  private async activateSession(id: string): Promise<ConversationSummary> {
    const workspace = await this.#harness.snapshot(WorkspaceDoc, context);
    const selected = workspace?.sessions.find(session => session.uuid === id);
    if (!selected) throw new AssistantError("SESSION_UNAVAILABLE", "此主会话不存在。");
    await this.configureConversation(await this.conversation(selected.id));
    await this.#harness.commit(async tx => { (await tx.doc(WorkspaceDoc)).activeId = selected.id; }, context);
    this.#current = { ...selected };
    return summary(selected);
  }
  async selectSession(id: string): Promise<ConversationSummary> {
    return this.serialize(async () => {
      if (id !== this.#current.uuid) await this.assertIdle();
      return this.activateSession(id);
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

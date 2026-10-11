import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  LiveDoc, defineExtension, defineTool,
  type AgentChange, type ConversationId, type Extension, type Harness, type ToolExecutionApi, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { AssistantError, type ModelSelection } from "../application/ports.js";
import type { ExpertSummary, Report, ToolPort } from "../application/business-ports.js";
import { can, requireCapability, type Capability } from "../application/permissions.js";
import { ExecutionService, type ApprovalInteraction } from "../application/execution.js";
import { DurableIntentStore } from "./durable-intent-store.js";
import { digest } from "./digest.js";
import { ExpertService, type DelegationInput } from "../application/experts.js";
import { ReportService } from "../application/reports.js";
import { canonical, type Evidence, type Json, type Parameters, type Role, type Scope } from "../domain/shared.js";
import { ArtifactDoc, ExpertDoc, RoundDoc, TeamDoc, WorkDoc, json } from "./runtime-documents.js";
import type { Research } from "./research.js";
import { ResourceSnapshot } from "./resources.js";
import type { MemoryPort } from "../application/memory.js";
import type { WorkspaceServices, ConfirmAction } from "./workspace-services.js";
import { fileTools } from "./file-tools.js";
import { codemodeTools } from "./codemode.js";
import { WorkspaceMemory } from "./workspace-memory.js";
import { memoryTools, callMemory } from "./memory-tools.js";
import { setupTools } from "./setup-tools.js";
import { durableExpertPort, ExpertAnchor } from "./durable-expert-port.js";
import { executionTools } from "./execution-tools.js";
import { result, toolError } from "./tool-result.js";

const context = BACKGROUND_CONTEXT;
export interface BusinessOptions {
  trading?: ToolPort;
  notices?: string[];
  approval?: ApprovalInteraction;
  emergency?: (message: string) => void;
  resources?: ResourceSnapshot;
  research?: Research;
  memory?: MemoryPort;
  services?: WorkspaceServices;
  confirmAction?: ConfirmAction;
  workingDirectory?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
const nativeParameters = Type.Record(Type.String(), Type.Unknown());
/** Assembles tools and agents; guards requests and stores shared evidence. */
export class BusinessIntegration {
  #extension: Extension;
  get extension(): Extension { return this.#extension; }
  readonly #options: BusinessOptions;
  #resources: ResourceSnapshot;
  readonly #model: ModelSelection;
  readonly #prompts: Record<Role, string>;
  #harness: Harness | undefined;
  #execution: ExecutionService | undefined;
  #intentStore: DurableIntentStore | undefined;
  #live: (scope: Scope) => boolean = () => false;
  private constructor(options: BusinessOptions, model: ModelSelection, prompts: Record<Role, string>) {
    this.#options = options; this.#resources = options.resources ?? ResourceSnapshot.defaults(); this.#model = model; this.#prompts = prompts;
    const tools: ToolRegistration[] = [
      defineTool({ name: "current_time", description: this.#resources.promptText("tools", "current_time"),
        parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
        execute: async (_args, api, ctx) => this.run(api, ctx, async () => result({ utc: new Date().toISOString() })) }),
      defineTool({ name: "source_catalog", description: this.#resources.promptText("tools", "source_catalog"),
        parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
        execute: async (_args, api, ctx) => this.run(api, ctx, async scope => {
          await this.#options.trading?.refresh(ctx.abortSignal);
          const trading = this.#options.trading;
          return result({ available: !!trading, status: options.services?.status() ?? trading?.status(), operations: trading?.catalog().filter(tool => !trading.allowed || trading.allowed(tool.name, scope.role)) ?? [], notices: this.#options.notices ?? [] });
        }) }),
      defineTool({ name: "source_read", description: this.#resources.promptText("tools", "source_read"),
        parameters: Type.Object({ operation: Type.String(), parameters: nativeParameters }, { additionalProperties: false }), replay: "safe",
        execute: async (args, api, ctx) => this.run(api, ctx, async scope => {
          requireCapability(scope.role, "read", this.#resources.roles);
          const trading = this.#options.trading;
          if (!trading) throw new AssistantError("TRADING_UNAVAILABLE", "未建立交易数据连接；可读资料/计算，不能编造市场数据。");
          if (trading.allowed && !trading.allowed(args.operation, scope.role)) throw new AssistantError("ROLE_DENIED", "当前角色没有该来源操作的授权。");
          canonical(args.parameters as Json);
          const parameters = json(args.parameters) as Parameters;
          const binding = trading.binding(args.operation);
          const observation = await trading.read({ name: args.operation, parameters }, ctx.abortSignal);
          const receipt = await this.evidence(api, scope, args.operation, parameters, observation.data, observation.success, binding, observation.raw);
          const text = JSON.stringify(observation.data);
          return result({ evidenceRef: receipt.ref, obtainedAt: receipt.obtainedAt, success: observation.success,
            ...(text.length <= 16000 ? { data: observation.data } : { preview: text.slice(0, 16000), truncated: true, next: this.#resources.promptText("runtime", "reportContinuation") }) }, !observation.success);
        }) }),
      defineTool({ name: "read_report", description: this.#resources.promptText("tools", "read_report"),
        parameters: Type.Object({ ref: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }, { additionalProperties: false }), replay: "safe",
        execute: async (args, api, ctx) => this.run(api, ctx, async scope => {
          const expert = await api.snapshot(ExpertDoc, api.conversationId, ctx);
          const service = new ReportService({ get: async (ownerId, ref) =>
            (await api.snapshot(ArtifactDoc, ownerId as ConversationId, ref, ctx))?.value as unknown as Report | Evidence | undefined });
          return result(await service.read(scope, args.ref, expert?.allowedRefs ?? [], args.offset, args.limit));
        }) }),
      defineTool({ name: "delegate_expert", description: this.#resources.promptText("tools", "delegate_expert"),
        parameters: Type.Object({ role: Type.Union(Object.keys(this.#resources.roles).filter(role => role !== "coordinator").map(role => Type.Literal(role))), goal: Type.String({ minLength: 1, maxLength: 24000 }),
          expertId: Type.Optional(Type.String()), reportRefs: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })), intentId: Type.Optional(Type.String()) }, { additionalProperties: false }),
        replay: "safe", executionMode: "parallel",
        execute: async (args, api, ctx) => this.run(api, ctx, async scope => {
          options.services?.requireInitialized();
          const service = new ExpertService(durableExpertPort(api, ctx, {
            resources: this.#resources, trading: options.trading,
            execution: () => this.execution(), harness: this.#harness!,
            agent: role => this.agent(role), scope: (api, ctx) => this.scope(api, ctx),
          }), this.#resources.roles);
          const report = await service.delegate(scope, `delegate:${api.taskId}`, args as DelegationInput);
          return result({ expertId: report.expertId, reportRef: report.ref, status: report.status, summary: report.content.slice(0, 8000),
            truncated: report.content.length > 8000, evidenceRefs: report.evidence.map(e => e.ref) }, report.status !== "answered");
        }) }),
    ];
    if (options.memory) tools.push(...memoryTools.map(tool => defineTool({ ...tool, replay: "safe",
      execute: async (args, api, ctx) => this.run(api, ctx, async scope => {
        requireCapability(scope.role, "read", this.#resources.roles); // Local knowledge is not computation or external write authority.
        return result(await callMemory(options.memory!, tool.name, args as Record<string, unknown>));
      }) })));
    const confirm = options.confirmAction ?? (async () => { throw new AssistantError("APPROVAL_UNAVAILABLE", "没有用户确认入口。"); });
    if (options.workingDirectory) tools.push(...fileTools(options.workingDirectory, confirm, (api, ctx) => this.scope(api, ctx)));
    if (options.services) {
      tools.push(...setupTools(options.services, confirm).map(tool => ({ ...tool, execute: async (args, api, ctx) => {
        const scope = await this.scope(api, ctx);
        if (scope.role !== "coordinator") throw new AssistantError("ROLE_DENIED", "只有协调者可以变更接入。");
        return tool.execute(args, api, ctx);
      } } as ToolRegistration)));
      tools.push(defineTool({ name: "finish_initialization", description: "使用当前主会话的实际行情和历史 K 线查询 evidenceRef 完成初始化。程序核实来源与回执，模型解释数据，用户确认。交易服务可选。",
        parameters: Type.Object({ market: Type.String({ minLength: 1 }), quoteRef: Type.String(), historyRef: Type.String() }, { additionalProperties: false }), replay: "unsafe", executionMode: "sequential",
        execute: async (args, api, ctx) => this.run(api, ctx, async scope => {
          if (scope.role !== "coordinator") throw new AssistantError("ROLE_DENIED", "只有协调者可以完成初始化。");
          const quote = (await api.snapshot(ArtifactDoc, scope.ownerId as ConversationId, args.quoteRef, ctx))?.value as unknown as Evidence | undefined;
          const history = (await api.snapshot(ArtifactDoc, scope.ownerId as ConversationId, args.historyRef, ctx))?.value as unknown as Evidence | undefined;
          return result(await options.services!.finish(args.market, quote, history, ctx.abortSignal));
        }) }));
    }
    if (options.research) tools.push(
      defineTool({ name: "research_list", description: "列出项目、长期事务和临时计算的运行记录。owner 可限定 projects/名称、areas/名称 或 scratch；用 read 阅读返回路径中的源码、日志和结果。",
        parameters: Type.Object({ owner: Type.Optional(Type.String()) }, { additionalProperties: false }), replay: "safe",
        execute: async (args, api, ctx) => this.run(api, ctx, async () => result(await options.research!.list(args.owner))) }),
      defineTool({ name: "research_status", description: "检查客户端管理的共享 Python 环境。",
        parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
        execute: async (_args, api, ctx) => this.run(api, ctx, async () => result(await options.research!.status())) }),
      defineTool({ name: "python", description: "在共享环境运行普通 Python，保存源码、inputs.json、依据、日志和产物。owner 可指定 projects/名称 或 areas/名称，省略则放入 scratch/runs，无需创建项目。代码从当前运行目录读 inputs.json，可导入 ffa_compute。不是沙箱。初始化完成后使用；中断不自动重放。",
        parameters: Type.Object({ owner: Type.Optional(Type.String()), code: Type.String({ minLength: 1, maxLength: 262144 }),
          inputs: Type.Optional(Type.Unknown()), evidenceRefs: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })) }, { additionalProperties: false }), replay: "unsafe",
        execute: async (args, api, ctx) => this.run(api, ctx, async scope => {
          options.services?.requireInitialized();
          requireCapability(scope.role, "compute", this.#resources.roles);
          const evidence: Json[] = [];
          for (const ref of args.evidenceRefs ?? []) {
            const value = await api.snapshot(ArtifactDoc, scope.ownerId as ConversationId, ref, ctx);
            if (!value) throw new AssistantError("REPORT_UNAVAILABLE", "依据引用不存在。");
            evidence.push(value.value as Json);
          }
          const value = await options.research!.run({ ...(args.owner !== undefined ? { owner: args.owner } : {}), code: args.code, inputs: json(args.inputs ?? null), evidence }, ctx.abortSignal);
          const successful = !!value && typeof value === "object" && !Array.isArray(value) && value.state === "completed";
          const receipt = await this.evidence(api, scope, "python", { owner: args.owner ?? "scratch" }, value, successful);
          return result({ evidenceRef: receipt.ref, data: value }, !successful);
        }) }),
    );
    tools.push(...codemodeTools((api, ctx) => this.scope(api, ctx)));
    tools.push(...executionTools({
      resources: this.#resources, services: options.services, trading: options.trading,
      execution: () => this.execution(),
      run: (api, ctx, call) => this.run(api, ctx, call),
      evidence: (api, scope, operation, parameters, value, success, binding, raw) =>
        this.evidence(api, scope, operation, parameters, value, success, binding, raw),
    }));
    this.#extension = defineExtension({ name: "fire.business", tools, tasks: [ExpertAnchor], sections: [
      { key: "fire-workspace", render: () => this.#resources.context(this.#options.services?.initialized ?? true) },
    ] });
  }
  static async create(options: BusinessOptions, model: ModelSelection): Promise<BusinessIntegration> {
    const prompts = {} as Record<Role, string>;
    const resources = options.resources ?? (options.workingDirectory ? await ResourceSnapshot.load(options.workingDirectory, options.services?.extensions) : ResourceSnapshot.defaults());
    const memory = options.memory ?? (options.workingDirectory ? new WorkspaceMemory(options.workingDirectory) : undefined);
    for (const role of Object.keys(resources.roles)) prompts[role] = resources.instructions(role);
    options = { ...options, resources, ...(memory ? { memory } : {}) };
    const integration = new BusinessIntegration(options, model, prompts);
    return integration;
  }
  async refreshResources(): Promise<void> {
    const resources = await this.#resources.refresh();
    for (const role of Object.keys(resources.roles)) this.#prompts[role] = resources.instructions(role);
    this.#resources = resources;
  }
  bind(harness: Harness, live: (scope: Scope) => boolean) {
    this.#harness = harness; this.#live = live;
    if (this.#options.trading) {
      this.#intentStore = new DurableIntentStore(harness);
      this.#execution = new ExecutionService(this.#intentStore, this.#options.trading, this.#options.approval ?? {
        confirm: async () => { throw new AssistantError("APPROVAL_UNAVAILABLE", "没有用户控制面；不能执行写入。"); }, revoke: () => {},
      }, { processEpoch: randomUUID(), id: randomUUID, now: () => new Date().toISOString(), hash: digest, isLive: live, emergency: this.#options.emergency ?? (() => {}) }, this.#resources.roles);
    }
  }
  async recover(): Promise<void> { await this.#execution?.recover(); }
  revoke(): void { this.#execution?.revoke(); }
  private execution(): ExecutionService { if (!this.#execution) throw new AssistantError("TRADING_UNAVAILABLE", "未连接已核实交易服务；不能写入或编造结果。"); return this.#execution; }
  agent(role: Role): AgentChange {
    if (!Object.hasOwn(this.#prompts, role)) throw new AssistantError("ROLE_DENIED", "角色未启用。");
    const requirements: Record<string, Capability> = { delegate_expert: "delegate", prepare_write: "prepare", execute_write: "execute",
      submit_review: "review", python: "compute" };
    return { model: this.#model, ...(this.#options.thinkingLevel ? { thinkingLevel: this.#options.thinkingLevel } : {}),
      extensions: [this.extension], tools: { remove: this.extension.tools!.filter(tool => requirements[tool.name] && !can(role, requirements[tool.name]!, this.#resources.roles) || role !== "coordinator" && ["locate_cli", "inspect_source", "install_package", "configure_source", "remove_source", "finish_initialization"].includes(tool.name)) }, instructions: this.#prompts[role]!, ...(this.#options.workingDirectory ? { cwd: this.#options.workingDirectory } : {}) };
  }
  async resolve(ownerId: number, id: string, revision: number, note: string): Promise<Json> {
    return json(await this.execution().resolve(ownerId, id, revision, note));
  }
  async scope(api: ToolExecutionApi, ctx: Context): Promise<Scope> {
    ctx.abortSignal?.throwIfAborted();
    const expert = await api.snapshot(ExpertDoc, api.conversationId, ctx);
    const ownerId = expert?.ownerId ?? api.conversationId;
    const request = (await api.snapshot(WorkDoc, ownerId, ctx))?.request;
    const scope: Scope = { conversationId: api.conversationId, ownerId, requestId: request?.requestId ?? "",
      role: expert?.role ?? "coordinator", roundId: expert?.roundId ?? request?.requestId ?? "" };
    if (!request || !["admitting", "running"].includes(request.status) || !this.#live(scope) ||
        (expert?.ownerId !== null && expert?.ownerId !== undefined && expert.requestId !== request.requestId)) {
      throw new AssistantError("REQUEST_INACTIVE", "当前请求已暂停/取消/结束；实际工具入口不能开始新工作。");
    }
    if (scope.role !== "coordinator") {
      const roster = await api.snapshot(TeamDoc, ownerId, ctx);
      if (!roster?.experts.some(e => e.conversationId === api.conversationId && e.role === scope.role && e.active === scope.roundId)) {
        throw new AssistantError("EXPERT_SCOPE_INVALID", "本专家不属于当前有效委派。");
      }
    }
    ctx.abortSignal?.throwIfAborted();
    const bound = await api.memo("fire.scope", json(scope), ctx);
    if (canonical(bound as Json) !== canonical(json(scope))) throw new AssistantError("REQUEST_INACTIVE", "工具调用属于另一请求，不能重绑历史工作。");
    if (!this.#live(scope)) throw new AssistantError("REQUEST_INACTIVE", "请求已停止。");
    return scope;
  }
  private async run(api: ToolExecutionApi, ctx: Context, call: (scope: Scope) => Promise<ReturnType<typeof result>>) {
    try { return await call(await this.scope(api, ctx)); } catch (error) { return toolError(error, this.#resources.promptText("runtime", "toolFailure")); }
  }
  private async evidence(api: ToolExecutionApi, scope: Scope, operation: string, parameters: Parameters, value: Json, success: boolean, binding?: Evidence["binding"], raw?: Json): Promise<Evidence> {
    const receipt: Evidence = { ref: `evidence:${api.taskId}:${randomUUID()}`, scope, operation, parameters, obtainedAt: new Date().toISOString(), success, result: value, ...(binding ? { binding } : {}), ...(raw ? { raw } : {}) };
    await api.commit(async tx => {
      const round = await tx.doc(RoundDoc, scope.conversationId as ConversationId, scope.roundId, json(scope));
      await tx.doc(ArtifactDoc, scope.ownerId as ConversationId, receipt.ref, json(receipt));
      round.evidenceRefs.push(receipt.ref);
    }, context);
    return receipt;
  }
  async status() { return { workspace: this.#options.services?.status() ?? null, execution: this.#execution ? await this.#execution.status() : { configured: false }, trading: this.#options.trading?.status?.() ?? { configured: !!this.#options.trading },
    research: this.#options.research ? await this.#options.research.status() : { available: false }, notices: this.#options.notices ?? [] }; }
  async intents(ownerId: ConversationId): Promise<Json[]> {
    const all = await this.#intentStore?.list() ?? [];
    return all.filter(i => i.ownerId === ownerId).map(json);
  }
  async experts(ownerId: ConversationId): Promise<ExpertSummary[]> {
    const team = await this.#harness!.snapshot(TeamDoc, ownerId, context);
    return Promise.all((team?.experts ?? []).map(async e => ({ expertId: e.expertId, role: e.role, purpose: e.purpose,
      reportRefs: [...e.reportRefs], busy: !!(await this.#harness!.snapshot(LiveDoc, e.conversationId, context))?.run })));
  }
}

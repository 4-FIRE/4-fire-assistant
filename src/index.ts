import { readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Store } from "./storage.js";
import { begin, state, prepareDirectories, documentsReady, finish, mutationTarget, type WorkspaceState } from "./workspace.js";
import { Sources, parseSource, type Receipt } from "./sources.js";
import { Trading, type Scope } from "./trading.js";
import { Experts, resourceRoot, roleText, type ExpertRef } from "./experts.js";
import { runPython } from "./research.js";
import { json, requireThat, result, type Params } from "./values.js";

interface Active {
  root: string; state: WorkspaceState; store: Store; sources: Sources; trading: Trading; controller: AbortController; notices: string[];
}
const params = Type.Record(Type.String(), Type.Unknown());
const name = Type.String({ minLength: 1, maxLength: 128 });
const empty = Type.Object({});
async function ask(ctx: ExtensionContext, title: string, value: unknown, signal?: AbortSignal) {
  requireThat(ctx.hasUI, "此操作需要用户确认通道，非交互模式不能授权。");
  signal?.throwIfAborted();
  const choice = await ctx.ui.select(title + "\n" + JSON.stringify(value, null, 2), ["取消", "确认"], signal ? { signal } : {});
  signal?.throwIfAborted(); return choice === "确认";
}
function callSignal(active: Active, signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal;
}

/** The factory has no filesystem writes, connections, or background work. */
export default function ffa(pi: ExtensionAPI) {
  let active: Active | undefined;
  let currentRequest = randomUUID();
  let confirmationQueue: Promise<unknown> = Promise.resolve();
  const confirm = (ctx: ExtensionContext, title: string, value: unknown, signal?: AbortSignal) => {
    const pending = confirmationQueue.then(() => ask(ctx, title, value, signal));
    confirmationQueue = pending.catch(() => undefined); return pending;
  };
  const experts = new Experts();
  const registered = new Map<string, ToolDefinition>();
  const register = (tool: ToolDefinition) => { registered.set(tool.name, tool); pi.registerTool(tool); };
  const get = (ready = false) => {
    requireThat(active && !active.controller.signal.aborted, "FFA 未启用；请执行 /ffa init。");
    requireThat(!ready || active.state.status === "ready", "请先完成工作区初始化。"); return active;
  };
  const scope = (ctx: ExtensionContext): Scope => ({ session: ctx.sessionManager.getSessionId(), request: currentRequest });
  const close = async () => {
    const old = active; active = undefined;
    if (old) {
      old.trading.revoke(); old.controller.abort();
      await old.sources.close(); old.store.close();
    }
    for (const tool of registered.values()) pi.registerTool({ ...tool, exposure: "hidden" });
  };
  const open = async (root: string, current: WorkspaceState) => {
    await close();
    const canonicalRoot = await realpath(root), store = new Store(join(canonicalRoot, ".ffa"), current.status === "pending");
    const sources = new Sources(canonicalRoot, store, pi);
    try {
      active = { root: canonicalRoot, state: current, store, sources, trading: new Trading(sources), controller: new AbortController(), notices: [] };
      for (const source of sources.list()) {
        try { sources.register(source); }
        catch { active.notices.push(source.id + "：Pi 数据连接未启用，请检查环境变量、同名配置与 /mcp。"); }
      }
      registerTools();
    } catch (error) { await close(); throw error; }
  };
  function queryTool(host?: ExtensionToolContext, evidence?: Set<string>) {
    return defineTool({ name: "ffa_source_read", label: "查询投资来源", description: "调用已确认的只读操作，保存真实回执。使用 ffa_sources 查看来源和参数。",
      parameters: Type.Object({ source: name, operation: name, parameters: params }),
      async execute(_id, args, signal, _update, ctx) {
        const a = get(), receipt = await a.sources.read(args.source, args.operation, json(args.parameters) as Params, host ?? ctx, callSignal(a, signal));
        evidence?.add(receipt.id);
        const text = JSON.stringify(receipt.data);
        return result({ ...receipt, data: text.length > 16000 ? { preview: text.slice(0, 16000), truncated: true, next: "ffa_record" } : receipt.data }, !receipt.success);
      } });
  }
  function pythonTool() {
    return defineTool({ name: "ffa_python", label: "Python 实验", description: "运行普通 Python 并保存源码、输入和结果。不是沙箱。可导入 ffa_compute。owner 可为 projects/名称 或 areas/名称，省略写入 scratch。",
      parameters: Type.Object({ code: Type.String({ minLength: 1, maxLength: 262144 }), inputs: Type.Optional(Type.Unknown()), owner: Type.Optional(Type.String()) }),
      async execute(_id, args, signal) {
        const a = get(true), python = a.store.get<string>("setting", "python") ?? "/usr/bin/python3";
        const value = await runPython(a.root, python, { code: args.code, inputs: json(args.inputs ?? null), ...(args.owner ? { owner: args.owner } : {}) }, callSignal(a, signal));
        const text = JSON.stringify(value.output);
        return result({ ...value, output: text.length > 16000 ? { preview: text.slice(0, 16000), truncated: true } : value.output }, value.state !== "completed");
      } });
  }
  function catalogTool() {
    return defineTool({ name: "ffa_sources", label: "投资来源", description: "列出本工作区已确认来源和操作约定，不返回凭据。MCP 尚未就绪时用 /mcp 检查。",
      parameters: empty, async execute() {
        const a = get(); return result({ sources: a.sources.list().map(s => ({ id: s.id, kind: s.kind, operations: s.operations })), notices: a.notices });
      } });
  }
  function recordTool() {
    return defineTool({ name: "ffa_record", label: "业务记录", description: "分页读取真实查询回执或交易意图。返回 JSON 文本片段，不修改记录。",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("receipt"), Type.Literal("intent")]), id: name,
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }),
      async execute(_id, args) {
        const value = get().store.get(args.kind, args.id); requireThat(value, "记录不存在。");
        const text = JSON.stringify(value), offset = args.offset ?? 0, limit = args.limit ?? 16000;
        requireThat(offset <= text.length, "分页位置超出记录。");
        return result({ text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null });
      } });
  }
  function registerTools() {
    register(catalogTool()); register(queryTool()); register(recordTool());
    register(defineTool({ name: "ffa_configure_source", label: "配置投资来源", exposure: "model-only", executionMode: "sequential",
      description: "经用户确认配置 CLI 或 MCP 来源。先读接入技能及服务说明。配置格式见包内 references/connections.md。凭据仅用 ${ENV_NAME} 引用；写操作不能作为普通 MCP 工具开放。",
      parameters: Type.Object({ source: Type.Unknown() }),
      async execute(_id, args, signal, _update, ctx) {
        const a = get(), parsed = parseSource(args.source), cancel = callSignal(a, signal);
        a.trading.revoke();
        requireThat(await confirm(ctx, "确认来源连接与操作权限（不是交易授权）", parsed, cancel), "用户未确认配置。");
        cancel.throwIfAborted(); a.trading.revoke(); await a.sources.configure(parsed);
        a.notices = a.notices.filter(note => !note.startsWith(parsed.id + "："));
        return result({ configured: parsed.id, next: "核实真实查询，并维护 sources/" + parsed.id + "/GUIDE.md。" });
      } }));
    if (get().state.status === "pending") {
      register(defineTool({ name: "ffa_finish_initialization", label: "完成投资工作区初始化", exposure: "model-only", executionMode: "sequential",
        description: "提交真实行情和历史 K 线回执 ID。检查资料、当前来源及用户确认后完成初始化。不会执行交易。",
        parameters: Type.Object({ market: Type.String({ minLength: 1 }), quote: name, history: name }),
        async execute(_id, args, signal, _update, ctx) {
          const a = get(), cancel = callSignal(a, signal);
          requireThat(a.state.status === "pending" && args.quote !== args.history, "需要两个独立查询回执。");
          const receipts = [args.quote, args.history].map(id => a.store.get<Receipt>("receipt", id));
          for (const receipt of receipts) {
            requireThat(receipt?.success, "需要成功的真实查询回执。");
            requireThat(receipt.binding === await a.sources.binding(receipt.source, receipt.operation, ctx), "查询来源已变化，请重新验证。");
          }
          await prepareDirectories(a.root);
          // A neutral navigation entry, never an initialization or investment-role prompt.
          await writeFile(join(a.root, "AGENTS.md"), "# 工作区资料\n\n长期事务见 areas，研究见 projects，知识见 knowledge，服务手册见 sources。\n", { flag: "wx" })
            .catch(error => { if (error.code !== "EEXIST") throw error; });
          await documentsReady(a.root, [...new Set(receipts.map(r => r!.source))]);
          requireThat(await confirm(ctx, "确认启用投资工作区", { root: a.root, market: args.market, quote: receipts[0], history: receipts[1] }, cancel), "用户未确认完成。");
          cancel.throwIfAborted();
          for (const receipt of receipts) requireThat(receipt!.binding === await a.sources.binding(receipt!.source, receipt!.operation, ctx), "确认期间来源变化，请重新验证。");
          await finish(a.root, args.market); a.state = { format: "ffa-pi/1", status: "ready", market: args.market };
          return result({ ready: true, next: "执行 Pi 原生 /reload 加载投资角色、技能和业务工具；下次启动自动启用。" });
        } }));
      return;
    }
    register(pythonTool());
    register(defineTool({ name: "ffa_status", label: "投资工作区状态", description: "查看初始化状态和本工作区待核对交易。不会执行或重发。",
      parameters: empty, async execute() { const a = get(true); return result({ workspace: a.state, unresolved: a.trading.ledger.unsettled(), notices: a.notices }); } }));
    register(defineTool({ name: "ffa_prepare_trade", label: "准备交易", executionMode: "sequential",
      description: "准备一次精确交易调用，不授权或发送。必须独立复核，再由用户确认。参数变化须准备新方案。",
      parameters: Type.Object({ objective: Type.String({ minLength: 1 }), source: name, operation: name, parameters: params }),
      async execute(_id, args, signal, _update, ctx) {
        const a = get(true); callSignal(a, signal).throwIfAborted();
        requireThat(a.sources.operation(args.source, args.operation).access === "write", "操作不是交易写入。");
        const parameters = json(args.parameters) as Params;
        a.sources.preview(args.source, args.operation, parameters);
        return result(a.trading.ledger.prepare(scope(ctx), args.objective, args.source, args.operation, parameters, await a.sources.binding(args.source, args.operation)));
      } }));
    register(defineTool({ name: "ffa_execute_trade", label: "确认并执行交易", exposure: "model-only", executionMode: "sequential",
      description: "独立复核通过后，请求用户确认全部原生参数并最多发送一次。结果不明时禁止重发。",
      parameters: Type.Object({ intentId: name }),
      async execute(_id, args, signal, _update, ctx) {
        const a = get(true), cancel = callSignal(a, signal);
        return result(await a.trading.execute(args.intentId, scope(ctx), value => confirm(ctx, "确认一次真实交易", value, cancel), cancel));
      } }));
    register(defineTool({ name: "ffa_delegate", label: "委派独立专家", exposure: "model-only",
      description: "按需创建研究员或独立交易复核员。expertId 可追问当前分支的研究员。复核必须指定当前 intentId，批准不等于用户授权。",
      parameters: Type.Object({ role: Type.Union([Type.Literal("researcher"), Type.Literal("reviewer")]), goal: Type.String({ minLength: 1, maxLength: 24000 }),
        expertId: Type.Optional(name), intentId: Type.Optional(name) }),
      async execute(_id, args, signal, onUpdate, ctx) {
        const a = get(true), cancel = callSignal(a, signal), originalScope = scope(ctx), generation = a.trading.generation;
        const refs = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ffa.expert")
          .map(entry => (entry as { data: ExpertRef }).data);
        const previous = args.expertId ? refs.find(ref => ref.id === args.expertId) : undefined;
        requireThat(!args.expertId || previous, "该专家不属于当前分支。");
        requireThat(args.role === "reviewer" ? args.intentId && !previous : !args.intentId, "复核需提供 intentId，并使用新的独立上下文。");
        const evidence = new Set<string>();
        const tools: ToolDefinition[] = [catalogTool(), queryTool(ctx, evidence), recordTool(), pythonTool()];
        let goal = args.goal;
        let reviewerId: string | undefined;
        if (args.role === "reviewer") {
          const intent = a.trading.ledger.get(args.intentId!);
          requireThat(intent.state === "prepared" && intent.session === originalScope.session && intent.request === originalScope.request, "复核方案不属于当前请求。");
          goal += "\n\n核实以下精确调用。自己查询关键事实，不将主助手报告当作独立证据。通过 ffa_submit_review 登记决定。\n" + JSON.stringify(intent);
          tools.push(defineTool({ name: "ffa_submit_review", label: "登记独立复核", executionMode: "sequential",
            description: "登记本次精确方案的复核决定。通过时必须引用本专家实际取得的查询回执。",
            parameters: Type.Object({ approved: Type.Boolean(), evidenceIds: Type.Array(name), note: Type.String({ minLength: 1 }) }),
            async execute(_id, decision) {
              cancel.throwIfAborted();
              requireThat(decision.evidenceIds.every(id => evidence.has(id)), "复核只能引用本专家取得的查询回执。");
              requireThat(reviewerId, "复核会话尚未建立。");
              a.trading.review(intent.id, originalScope, generation, reviewerId, decision.approved, decision.evidenceIds, decision.note);
              return result({ approved: decision.approved });
            } }));
        }
        onUpdate?.(result({ status: "running", role: args.role }));
        try {
          const answer = await experts.run(ctx, args.role, goal, tools, ref => {
            reviewerId = ref.id;
            if (!previous) pi.appendEntry("ffa.expert", ref);
          }, previous, cancel, progress => onUpdate?.(result(progress)));
          if (answer.failed) a.trading.revoke();
          return { ...result({ expert: answer.expert, report: answer.report, failed: answer.failed }, answer.failed), usage: answer.usage };
        } catch (error) { a.trading.revoke(); throw error; }
      } }));
  }

  pi.on("session_start", async (_event, ctx) => {
    await close();
    try {
      const current = await state(ctx.cwd);
      if (current?.status === "ready") await open(ctx.cwd, current);
      else if (ctx.hasUI) ctx.ui.notify(current ? "初始化未完成；执行 /ffa init 接续。" : "FFA 未启用；需要时执行 /ffa init。", "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "FFA 启动失败。", "error");
      else throw error;
    }
  });
  pi.on("resources_discover", () => active?.state.status === "ready" ? { skillPaths: [join(resourceRoot, "skills")] } : {});
  pi.on("before_agent_start", async event => {
    if (!active) return;
    currentRequest = randomUUID(); active.trading.revoke();
    event.systemPromptOptions.sections.ffa = "FFA 包内资料根目录：" + resourceRoot + "\n" + (active.state.status === "ready"
      ? await roleText("coordinator", active.root)
      : await readFile(join(resourceRoot, "initialization.md"), "utf8"));
  });
  pi.on("input", () => { active?.trading.revoke(); });
  pi.on("agent_end", () => { active?.trading.revoke(); });
  pi.on("session_before_switch", () => { active?.trading.revoke(); });
  pi.on("session_before_fork", () => { active?.trading.revoke(); });
  pi.on("session_before_tree", () => { active?.trading.revoke(); });
  pi.on("session_shutdown", close);
  pi.on("tool_call", async (event, ctx) => {
    if (!active) return;
    if (active.sources.blocks(event.toolName)) return { block: true, reason: "此原生 MCP 操作没有 FFA 只读许可。交易只能通过受控入口。" };
    if (["write", "edit"].includes(event.toolName) && "path" in event.input && typeof event.input.path === "string") {
      const target = await mutationTarget(resolve(ctx.cwd, event.input.path));
      const rel = relative(active.root, target);
      if (rel === ".ffa" || rel.startsWith(".ffa/")) return { block: true, reason: "内部状态必须通过 FFA 专用操作修改。" };
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        if (!await confirm(ctx, "确认修改工作区外文件", { path: target }, ctx.signal)) return { block: true, reason: "用户未确认外部文件修改。" };
      }
    }
    return;
  });
  pi.registerCommand("ffa", {
    description: "投资工作区：init、status、revoke、resolve ID 核对依据、python /绝对路径",
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      if (command === "init") {
        await ctx.waitForIdle();
        const current = await state(ctx.cwd);
        if (current?.status === "ready") { await ctx.reload(); return; }
        requireThat(await confirm(ctx, current ? "继续投资工作区初始化？" : "在此目录创建投资工作区？", { root: await realpath(ctx.cwd) }), "用户未开启初始化。");
        const initial = await begin(ctx.cwd); await open(ctx.cwd, initial); await prepareDirectories(ctx.cwd);
        pi.sendUserMessage("请引导投资工作区初始化。理解目标市场和已有服务，整合资料，验证真实行情及历史 K 线，最后请求完成确认。不要执行交易。");
        return;
      }
      if (command === "status") {
        const current = await state(ctx.cwd);
        ctx.ui.notify(JSON.stringify({ state: current ?? "inactive", unresolved: active?.trading.ledger.unsettled() ?? [] }, null, 2), "info"); return;
      }
      const a = get();
      if (command === "revoke") { a.trading.revoke(); ctx.ui.notify("未消费许可已撤销。", "info"); return; }
      if (command === "resolve") {
        await ctx.waitForIdle();
        const id = rest.shift(), note = rest.join(" "); requireThat(id && note, "用法：/ffa resolve ID 核对依据");
        requireThat(await confirm(ctx, "确认人工结案（不重发）", { intent: a.trading.ledger.get(id), note }), "用户未确认结案。");
        a.trading.ledger.resolve(id, note); ctx.ui.notify("已记录核对结论；不授权重发。", "info"); return;
      }
      if (command === "python") {
        const path = rest.join(" "); requireThat(isAbsolute(path), "需要 Python 可执行文件的绝对路径。");
        requireThat(await confirm(ctx, "确认共享 Python 环境", { path }), "用户未确认。");
        a.store.put("setting", "python", await realpath(path)); return;
      }
      ctx.ui.notify("用法：/ffa init | status | revoke | resolve ID 核对依据 | python /绝对路径", "info");
    },
  });
}

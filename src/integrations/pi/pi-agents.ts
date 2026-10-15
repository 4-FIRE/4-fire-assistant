import { InMemoryCredentialStore, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionContext, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireThat } from "../../common/validation.js";
import { AgentRef, type AgentProgress, type AgentUsage, type SteeringStatus } from "../../model/agent.js";
import { agentLoader } from "./agent-resources.js";

// The child must use host authentication for SDK preflight and request paths.
// OAuth-only providers cannot resolve a copied runtime API-key credential.
export async function agentModelRuntime(registry: ModelRegistry, model: Model<Api>) {
  const provider = registry.getProvider(model.provider);
  requireThat(provider, "当前模型的提供方不可用。");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider({ ...provider,
    auth: { apiKey: { name: "Pi host authentication",
      async check({ signal }) {
        signal.throwIfAborted();
        if (!registry.hasConfiguredAuth(model) && !await registry.getProviderAuth(model.provider)) return undefined;
        return { type: registry.isUsingOAuth(model) ? "oauth" : "api_key", source: "Pi host" };
      },
      async resolve({ signal }) {
        signal.throwIfAborted();
        if (!registry.hasConfiguredAuth(model) && !await registry.getProviderAuth(model.provider)) return undefined;
        const auth = await registry.getApiKeyAndHeaders(model);
        requireThat(auth.ok, auth.ok ? "" : auth.error);
        return { auth: { ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
          ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
          ...(auth.baseUrl !== undefined ? { baseUrl: auth.baseUrl } : {}) },
          ...(auth.env !== undefined ? { env: auth.env } : {}), source: "Pi host" };
      } } },
    stream: (selected, context, options) => provider.stream(selected, context, options),
    streamSimple: (selected, context, options) => registry.streamSimple(selected, context, options),
  });
  return runtime;
}

/** Open a fresh native branch from the exact history visible to the coordinator. */
export async function agentSession(root: string, sessions: string, previous?: AgentRef) {
  if (!previous) return SessionManager.create(root, sessions);
  const manager = await openAgentSession(root, sessions, previous);
  requireThat(previous.leaf !== null, "专家接续位置无效。");
  manager.createBranchedSession(previous.leaf);
  return manager;
}

export async function openAgentSession(root: string, sessions: string, ref: AgentRef) {
  const file = await realpath(ref.file), base = await realpath(sessions);
  requireThat(relative(base, file) && dirname(file) === base, "专家会话不在当前 Pi 会话目录。");
  const manager = SessionManager.open(file);
  requireThat(await realpath(manager.getCwd()) === await realpath(root), "专家工作区不匹配。");
  requireThat(ref.leaf === null || manager.getEntry(ref.leaf), "专家接续位置无效。");
  return manager;
}
export async function agentHistory(root: string, sessions: string, ref: AgentRef) {
  if (ref.leaf === null) return "";
  const manager = await openAgentSession(root, sessions, ref);
  return manager.getBranch(ref.leaf).flatMap(entry => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "system") return [];
    if (message.role === "user") return ["## 用户\n" + (typeof message.content === "string" ? message.content :
      message.content.filter(part => part.type === "text").map(part => part.text).join("\n"))];
    if (message.role === "assistant") return ["## 专家\n" + message.content.map(part =>
      part.type === "text" ? part.text : part.type === "toolCall" ? `工具 ${part.name}\n\`\`\`json\n${JSON.stringify(part.arguments)}\n\`\`\`` : "").join("\n")];
    if (message.role === "toolResult") return [`## 工具 ${message.toolName}\n` +
      message.content.filter(part => part.type === "text").map(part => part.text).join("\n")];
    return [];
  }).join("\n\n");
}

/** Only entries appended after this request's checkpoint can supply its answer or usage. */
export function agentTurn(manager: SessionManager, checkpoint: string | null) {
  const branch = manager.getBranch();
  const position = checkpoint === null ? -1 : branch.findIndex(entry => entry.id === checkpoint);
  requireThat(checkpoint === null || position >= 0, "专家执行位置失效。");
  const entries = branch.slice(position + 1);
  const assistants = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
  const last = assistants.at(-1);
  const report = assistants.map(message => message.content.filter(part => part.type === "text").map(part => part.text).join("\n"))
    .filter(text => text.trim()).at(-1) ?? "";
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const entry of entries) {
    const value = entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
      ? entry.message.usage : "usage" in entry ? entry.usage as Usage | undefined : undefined;
    if (!value) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += value[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += value.cost[key];
    for (const key of ["reasoning", "cacheWrite1h"] as const) if (value[key] !== undefined) usage[key] = (usage[key] ?? 0) + value[key];
  }
  const finalText = last?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  const failed = !last || last.stopReason !== "stop" || !finalText.trim();
  return { report, failed, usage, ...(failed ? { error: last?.errorMessage ?? "专家未交付有效的最终回答。" } : {}) };
}

export class PiAgents {
  async run(ctx: ExtensionContext, agent: string, message: string, tools: ToolDefinition[],
    previous: AgentRef | undefined, signal: AbortSignal,
    onProgress: (value: AgentProgress) => void, control: (steer: (text: string) => Promise<SteeringStatus>) => void) {
    requireThat(ctx.model, "未选择模型。"); signal.throwIfAborted();
    const model = ctx.model;
    const manager = await agentSession(ctx.cwd, ctx.sessionManager.getSessionDir(), previous);
    const runtime = await agentModelRuntime(ctx.modelRegistry, model);
    const { session } = await createAgentSession({ cwd: ctx.cwd, model, modelRuntime: runtime,
      ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}), sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
      resourceLoader: await agentLoader(ctx.cwd, agent),
      tools: ["read", "bash", "write", "edit", "grep", "find", "ls", ...tools.map(t => t.name)], customTools: tools });
    const ref = new AgentRef({ conversationId: previous?.conversationId ?? randomUUID(), agent, file: manager.getSessionFile()!, leaf: manager.getLeafId() });
    const checkpoint = manager.getLeafId();
    let partial = "", lastProgressAt = 0;
    const unsubscribe = session.subscribe(event => {
      if (event.type === "tool_execution_start") onProgress({ activity: event.toolName });
      if (event.type === "message_start" && event.message.role === "assistant") partial = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        partial += event.assistantMessageEvent.delta;
        if (Date.now() - lastProgressAt >= 100) {
          lastProgressAt = Date.now(); onProgress({ activity: "回答", report: partial });
        }
      }
      // message_end listeners run before SDK persistence. turn_end/agent_end see finalized entries.
      if (event.type === "turn_end" || event.type === "agent_end") {
        onProgress({ session: new AgentRef({ ...ref, leaf: manager.getLeafId() }), ...agentTurn(manager, checkpoint) });
      }
    });
    const abort = () => { void session.abort().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted(); onProgress({ session: ref });
      control(async text => {
        signal.throwIfAborted();
        requireThat(session.isStreaming, "专家正在启动或已停止；请等待或使用 action=continue。");
        return session.steer(text);
      });
      await session.prompt(message);
      signal.throwIfAborted();
      return { session: new AgentRef({ ...ref, leaf: manager.getLeafId() }), ...agentTurn(manager, checkpoint) };
    } finally {
      try {
        await session.abort();
        const finalRef = new AgentRef({ ...ref, leaf: manager.getLeafId() });
        onProgress({ session: finalRef, ...agentTurn(manager, checkpoint) });
      } finally { signal.removeEventListener("abort", abort); unsubscribe(); session.dispose(); }
    }
  }
}

import { InMemoryCredentialStore, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionContext, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireThat } from "../common/validation.js";
import { ExpertRef } from "../model/expert.js";
import { expertLoader } from "./expert-resources.js";

// The child must use host authentication for SDK preflight and request paths.
// OAuth-only providers cannot resolve a copied runtime API-key credential.
export async function expertModelRuntime(registry: ModelRegistry, model: Model<Api>) {
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

export class PiExperts {
  readonly #busy = new Set<string>();
  async run(ctx: ExtensionContext, role: ExpertRef["role"], goal: string, tools: ToolDefinition[],
    remember: (ref: ExpertRef) => void, previous?: ExpertRef, signal?: AbortSignal, onProgress?: (value: unknown) => void) {
    requireThat(ctx.model, "未选择模型。"); signal?.throwIfAborted();
    const sessions = ctx.sessionManager.getSessionDir();
    if (previous) {
      const file = await realpath(previous.file), base = await realpath(sessions);
      requireThat(relative(base, file) && dirname(file) === base, "专家会话不在当前 Pi 会话目录。");
    }
    const manager = previous ? SessionManager.open(previous.file) : SessionManager.create(ctx.cwd, sessions);
    const ref = previous ?? new ExpertRef({ id: randomUUID(), role, file: manager.getSessionFile()! });
    requireThat(!this.#busy.has(ref.id), "专家正在处理另一请求。"); this.#busy.add(ref.id);
    try {
      const runtime = await expertModelRuntime(ctx.modelRegistry, ctx.model);
      const { session } = await createAgentSession({ cwd: ctx.cwd, model: ctx.model, modelRuntime: runtime,
        ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}), sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
        resourceLoader: await expertLoader(ctx.cwd, role), tools: ["read", "grep", "find", "ls", ...tools.map(t => t.name)], customTools: tools });
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const unsubscribe = session.subscribe(event => {
        if (event.type === "tool_execution_start") onProgress?.({ expertId: ref.id, role, tool: event.toolName });
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const value = event.message.usage;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += value[key];
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += value.cost[key];
      });
      const abort = () => { void session.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted(); remember(ref);
        await session.prompt(goal); signal?.throwIfAborted();
        const last = session.messages.filter(message => message.role === "assistant").at(-1);
        const failed = !last || last.role !== "assistant" || ["error", "aborted", "length"].includes(last.stopReason);
        return { expert: ref, report: session.getLastAssistantText() ?? "专家未交付最终回答。", failed, usage };
      } finally { signal?.removeEventListener("abort", abort); unsubscribe(); session.dispose(); }
    } finally { this.#busy.delete(ref.id); }
  }
}

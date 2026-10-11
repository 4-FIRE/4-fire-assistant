import type { Usage } from "@earendil-works/pi-ai";
import { readFile, realpath } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  loadSkillsFromDir, formatSkillsForPrompt, type ResourceLoader, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireThat } from "./values.js";

export const resourceRoot = fileURLToPath(new URL("../resources/", import.meta.url));
export interface ExpertRef { id: string; role: "researcher" | "reviewer"; file: string }
export async function roleText(role: "coordinator" | "researcher" | "reviewer", root: string) {
  let text = await readFile(join(resourceRoot, "roles", role + ".md"), "utf8");
  try { text += "\n\n工作区职责补充：\n" + await readFile(join(root, "roles", role + ".md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return text;
}
export async function expertLoader(root: string, role: ExpertRef["role"]): Promise<ResourceLoader> {
  const bundled = loadSkillsFromDir({ dir: join(resourceRoot, "skills"), source: "ffa" });
  const local = loadSkillsFromDir({ dir: join(root, ".agents", "skills"), source: "workspace" });
  const skills = [...local.skills, ...bundled.skills.filter(s => !local.skills.some(l => l.name === s.name))];
  const context: { path: string; content: string }[] = [];
  for (const path of ["AGENTS.md", "sources/AGENTS.md"]) {
    try { context.push({ path: join(root, path), content: await readFile(join(root, path), "utf8") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const prompt = "FFA 包内资料根目录：" + resourceRoot + "\n" + await roleText(role, root);
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills, diagnostics: [...local.diagnostics, ...bundled.diagnostics] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: context }),
    getSystemPrompt: () => prompt + "\n" + context.map(c => c.content).join("\n") + "\n" + formatSkillsForPrompt(skills),
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}
export class Experts {
  readonly #busy = new Set<string>();
  async run(ctx: ExtensionContext, role: ExpertRef["role"], goal: string, tools: ToolDefinition[],
    remember: (ref: ExpertRef) => void, previous?: ExpertRef, signal?: AbortSignal, onProgress?: (value: unknown) => void) {
    requireThat(ctx.model, "未选择模型。"); signal?.throwIfAborted();
    requireThat(!previous || previous.role === role, "专家角色不匹配。");
    const sessions = ctx.sessionManager.getSessionDir();
    if (previous) {
      const file = await realpath(previous.file), base = await realpath(sessions);
      requireThat(relative(base, file) && dirname(file) === base, "专家会话不在当前 Pi 会话目录。");
    }
    const manager = previous ? SessionManager.open(previous.file) : SessionManager.create(ctx.cwd, sessions);
    const ref: ExpertRef = previous ?? { id: randomUUID(), role, file: manager.getSessionFile()! };
    requireThat(!this.#busy.has(ref.id), "专家正在处理另一请求。"); this.#busy.add(ref.id);
    try {
      const runtime = await ModelRuntime.create();
      for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
        const native = ctx.modelRegistry.getRegisteredNativeProvider(id), config = ctx.modelRegistry.getRegisteredProviderConfig(id);
        if (native) runtime.registerNativeProvider(native); else if (config) runtime.registerProvider(id, config);
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (auth.ok && auth.apiKey) await runtime.setRuntimeApiKey(ctx.model.provider, auth.apiKey);
      const { session } = await createAgentSession({ cwd: ctx.cwd, model: ctx.model, modelRuntime: runtime,
        ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}), sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
        resourceLoader: await expertLoader(ctx.cwd, role), tools: ["read", "grep", "find", "ls", ...tools.map(t => t.name)], customTools: tools });
      // Use the dispatching host's provider and auth resolution, including extension providers.
      session.agent.streamFunction = (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options);
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

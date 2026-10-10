import type { SetupDraft, SetupMessage, SetupSource, WorkspaceConfig } from "../domain/workspace.js";
import type { MemoryPort } from "./memory.js";
import { AssistantError } from "./ports.js";

export interface InitializationReply { message: string }
export interface McpInstallation { name: string; command: string; args: string[]; repeat?: boolean }
/** Explicit configuration operations are separate from natural-language replies and knowledge. */
export interface InitializationTools {
  memory?: MemoryPort;
  beginRequest?(id: string): void;
  locateCli?(command: string, signal: AbortSignal): Promise<string>;
  inspect?(source: SetupSource, signal: AbortSignal, refresh?: boolean): Promise<string>;
  readDocument?(path: string, signal: AbortSignal, offset?: number): Promise<{ text: string; nextOffset: number | null }>;
  installMcp?(request: McpInstallation, signal: AbortSignal): Promise<string>;
  proposeSource?(source: SetupSource, signal: AbortSignal): Promise<SetupDraft>;
  removeSource?(id: string, signal: AbortSignal): Promise<SetupDraft>;
}
export interface InitializationModel {
  respond(messages: readonly SetupMessage[], draft: SetupDraft, signal: AbortSignal, tools?: InitializationTools): Promise<InitializationReply>;
}
export interface InitializationInteraction {
  signal: AbortSignal;
  show(text: string, role?: "assistant"): void;
  activity?(text: string): void;
  ask(): Promise<string | undefined>;
  confirm(draft: SetupDraft): Promise<boolean>;
  confirmDiscovery?(source: SetupSource, entry: string, signal?: AbortSignal): Promise<boolean>;
  confirmAction?(description: string, entry: string, signal?: AbortSignal): Promise<boolean>;
}
export interface InitializationDiscovery {
  locateCli?(command: string, signal: AbortSignal): Promise<string>;
  entry(source: SetupSource): string;
  inspect(source: SetupSource, signal: AbortSignal): Promise<string>;
  readDocument?(path: string, signal: AbortSignal, offset?: number): Promise<{ text: string; nextOffset: number | null }>;
  installationEntry?(request: McpInstallation): string;
  installMcp?(request: McpInstallation, signal: AbortSignal): Promise<string>;
}

export function upsertSource(draft: SetupDraft, source: SetupSource): SetupDraft {
  const next = structuredClone(draft), selected = structuredClone(source);
  const index = next.sources.findIndex(item => selected.id ? item.id === selected.id : item.name === selected.name && item.kind === selected.kind);
  if (index < 0) next.sources.push(selected); else next.sources[index] = selected;
  return next;
}

/** Shared metadata and memory access for initialization and later connection maintenance. */
export function metadataTools(discovery: InitializationDiscovery | undefined, memory: MemoryPort | undefined,
  interaction: Pick<InitializationInteraction, "show" | "activity" | "confirmDiscovery" | "confirmAction">,
  declined = new Set<string>()): InitializationTools {
  const receipts = new Map<string, string>(), approvedDocuments = new Set<string>(), attemptedInstallations = new Set<string>();
  let requestId: string | undefined;
  const remember = async (key: string, content: string, replace = false) => {
    if (!memory) return;
    try { await memory.record(key, content, replace); }
    catch { throw new AssistantError("SETUP_SAVE_FAILED", "外部动作可能已完成，但材料未可靠保存到记忆；请修复存储并核对实际状态，不能宣称未执行或自动重装。"); }
  };
  return {
    ...(memory ? { memory } : {}),
    beginRequest: id => { if (requestId !== id) { requestId = id; declined.clear(); approvedDocuments.clear(); attemptedInstallations.clear(); } },
    ...(discovery?.locateCli ? { locateCli: discovery.locateCli.bind(discovery) } : {}),
    ...(discovery && interaction.confirmDiscovery ? { inspect: async (source: SetupSource, signal: AbortSignal, refresh = false) => {
      signal.throwIfAborted();
      const selected = structuredClone(source);
      const entry = discovery.entry(selected), key = "discovery:" + entry;
      const cached = receipts.get(entry) ?? await memory?.recorded(key);
      if (!refresh && cached !== undefined) return cached;
      if (declined.has(entry) || !await interaction.confirmDiscovery!(selected, entry, signal)) {
        declined.add(entry);
        await remember("declined:" + entry, `用户拒绝了此次接口发现，不要自动再次请求。\n入口：${entry}\n后续明确的新请求不从这条记忆取得执行许可。`);
        throw new AssistantError("SETUP_DISCOVERY_DECLINED", "用户取消了此次发现，不要自动重试或换参数执行；可继续分析已有材料。");
      }
      signal.throwIfAborted();
      interaction.activity?.(`读取 ${selected.name} 的接口说明`);
      let metadata: string;
      try { metadata = await discovery.inspect(selected, signal); signal.throwIfAborted(); }
      finally { interaction.activity?.("AI 正在整理初始化材料"); }
      const content = `# ${selected.name} 接口发现\n\n入口：${entry}\n取得时间：${new Date().toISOString()}\n\n${metadata}`;
      await remember(key, content, refresh);
      receipts.set(entry, content);
      interaction.show(`已取得 ${selected.name} 的接口说明并保留为记忆；尚未授予工具权限。`);
      return content;
    } } : {}),
    ...(discovery?.readDocument && interaction.confirmAction ? { readDocument: async (path: string, signal: AbortSignal, offset = 0) => {
      if (!approvedDocuments.has(path)) {
        if (declined.has("document:" + path) || !await interaction.confirmAction!("读取用户提供的资料；不要选择凭据文件", path, signal)) {
          declined.add("document:" + path);
          await remember("declined-document:" + path, `用户拒绝读取资料：${path}；不要自动换路径或翻页重试。`);
          throw new AssistantError("SETUP_DOCUMENT_DECLINED", "用户取消了资料读取，不要自动换路径重试。");
        }
        approvedDocuments.add(path);
      }
      signal.throwIfAborted();
      const page = await discovery.readDocument!(path, signal, offset);
      await remember(`document:${path}:${offset}:${page.text}`, `# 资料记忆：${path}\n\n读取位置：${offset}；后续位置：${page.nextOffset ?? "已完整读取"}\n\n${page.text}`);
      return page;
    } } : {}),
    ...(discovery?.installMcp && discovery.installationEntry && interaction.confirmAction ? { installMcp: async (request: McpInstallation, signal: AbortSignal) => {
      const entry = discovery.installationEntry!(request), key = "mcp-install:" + entry;
      const previous = await memory?.recorded(key);
      if (!request.repeat && previous !== undefined) return previous + "\n这是已保存安装回执，未重新执行；请发现接口核实当前可用性。";
      if (attemptedInstallations.has(entry)) throw new AssistantError("MCP_INSTALL_CHECK_REQUIRED", "本请求已尝试此安装；不能自动重装。先核对实际状态，再由新的用户请求决定。");
      if (declined.has("install:" + entry) || !await interaction.confirmAction!(`安装 MCP：${request.name}。包及安装脚本必须可信；安装不授予业务权限`, entry, signal)) {
        declined.add("install:" + entry);
        await remember("declined-install:" + entry, `用户拒绝此次 MCP 安装，不要自动重试。\n入口：${entry}`);
        throw new AssistantError("MCP_INSTALL_DECLINED", "用户取消了此次安装，不要自动重试。");
      }
      signal.throwIfAborted();
      attemptedInstallations.add(entry);
      let output: string;
      try { output = await discovery.installMcp!(request, signal); }
      catch (error) {
        await remember("mcp-install-attempt:" + entry + ":" + new Date().toISOString(), `# MCP 安装未确认完成：${request.name}\n\n入口：${entry}\n已尝试执行，可能留下部分文件；核对实际状态，不自动重装。\n${error instanceof AssistantError ? error.message : "安装未完成或被取消。"}`);
        throw error;
      }
      const receipt = `# MCP 安装回执：${request.name}\n\n入口：${entry}\n完成时间：${new Date().toISOString()}\n安装进程成功退出；尚须发现接口、提交接入约定并由用户确认权限。\n\n${output}`;
      await remember(key, receipt, request.repeat);
      signal.throwIfAborted();
      return receipt;
    } } : {}),
  };
}

/** The application owns durable commits and confirmations; the model owns conversation and planning. */
export async function initializeWorkspace(config: WorkspaceConfig, model: InitializationModel,
  interaction: InitializationInteraction, save: (config: WorkspaceConfig) => Promise<void>, discovery?: InitializationDiscovery,
  memory?: MemoryPort): Promise<boolean> {
  if (config.initialization === "complete") return true;
  let current = structuredClone(config);
  const declined = new Set<string>();
  const persist = async (next: WorkspaceConfig) => {
    try { await save(structuredClone(next)); }
    catch (error) { throw new AssistantError("SETUP_SAVE_FAILED", `${error instanceof AssistantError ? error.message : "初始化材料保存失败；请检查存储。"} 初始化仍未完成；修正后可重试。未保存的输入仅在本次会话中保留。`); }
    current = next;
  };
  const tools: InitializationTools = {
    ...metadataTools(discovery, memory, interaction, declined),
    proposeSource: async (source, signal) => {
      signal.throwIfAborted();
      await persist({ ...current, draft: upsertSource(current.draft, source) });
      return structuredClone(current.draft);
    },
    removeSource: async (id, signal) => {
      signal.throwIfAborted();
      if (!current.draft.sources.some(source => source.id === id)) throw new AssistantError("SOURCE_MISSING", "没有这个来源标识；先查看当前接入方案。");
      await persist({ ...current, draft: { sources: current.draft.sources.filter(source => source.id !== id) } });
      return structuredClone(current.draft);
    },
  };
  let request = 0;
  const respond = async () => {
    tools.beginRequest?.(String(++request));
    try {
      await persist(current);
      interaction.signal.throwIfAborted();
      const reply = await model.respond(structuredClone(current.messages), structuredClone(current.draft), interaction.signal, tools);
      interaction.signal.throwIfAborted();
      if (!reply.message.trim()) throw new AssistantError("SETUP_REPLY_EMPTY", "模型未交付回答；进度保留，可重试。");
      // A reply cannot replace sources, remove knowledge, or grant permission.
      await persist({ ...current, messages: [...current.messages, { role: "assistant", text: reply.message }] });
      if (!interaction.signal.aborted) interaction.show(reply.message, "assistant");
    } catch (error) {
      if (!interaction.signal.aborted) interaction.show(error instanceof AssistantError ? error.message : "本次处理未完成，已保存的进度已保留；可补充信息或输入 /retry。");
    }
  };
  interaction.show("工作区初始化\n直接回答或提供工具文档，由 AI 阅读、分析并按需推进。需要保留的知识作为记忆；MCP 安装、外部发现和接入权限分别确认。请勿提供密码或密钥。\nCtrl+P 操作菜单 · /help · /quit");
  if (current.messages.length) {
    interaction.show("已恢复初始化进度。");
    const last = current.messages.at(-1)!;
    interaction.show(last.role === "assistant" ? last.text : `上次输入已保存：${last.text}\n可输入 /retry 继续，或补充信息。`, last.role === "assistant" ? "assistant" : undefined);
  } else await respond();
  while (!interaction.signal.aborted) {
    const input = await interaction.ask();
    if (input === undefined || input.trim() === "/quit") return false;
    if (!input.trim()) continue;
    if (input.trim() === "/help") {
      interaction.show("自然语言说明目标或提供资料；由模型决定阅读、分析和澄清。/retry 继续整理；/finish 查看明确提出的接入方案并确认；/quit 退出。记忆不是安装，也不是执行许可。"); continue;
    }
    if (input.trim() === "/finish") {
      try {
        if (!await interaction.confirm(structuredClone(current.draft))) continue;
        interaction.signal.throwIfAborted();
        await persist({ ...current, initialization: "complete" }); return true;
      } catch (error) { if (!interaction.signal.aborted) interaction.show(error instanceof AssistantError ? error.message : "保存未完成，请修复后重试。"); }
      continue;
    }
    declined.clear(); // New explicit user interaction, not an automatic model retry.
    if (input.trim() === "/retry") { await respond(); continue; }
    if (input.length > 32_000) { interaction.show("消息过长；请分段提供必要说明。"); continue; }
    current.messages.push({ role: "user", text: input });
    await respond();
  }
  return false;
}

import type { InitializationModel, InitializationDiscovery } from "../application/initialization.js";
import { initializeWorkspace } from "../application/initialization.js";
import { AssistantError } from "../application/ports.js";
import type { SetupDraft, WorkspaceConfig } from "../domain/workspace.js";
import type { MemoryPort } from "../application/memory.js";
import { AssistantScreen } from "./screen.js";

export function formatInitializationDraft(draft: SetupDraft): string {
  const lines = ["\n工具接入草案"];
  if (!draft.sources.length) lines.push("工具来源：暂不接入");
  for (const [index, source] of draft.sources.entries()) {
    const ready = source.id && source.connection && source.operations?.length;
    lines.push(`\n${index + 1}. ${source.name}（${source.kind}）`, `地址或路径：${source.location || "待补充"}`);
    if (source.description) lines.push(`用途：${source.description}`);
    if (source.missing.length) lines.push(`待补充：${source.missing.join("；")}`);
    lines.push(ready ? "将保存调用约定，启动时核对接口后启用。" : "材料不足，暂不启用。");
    // Keep exact connection and operation contracts visible before granting access.
    if (ready) lines.push("接入详情（请核对连接、参数和角色权限）：", JSON.stringify(source, null, 2));
  }
  return lines.join("\n");
}

export async function confirmWorkspaceCreation(root: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new AssistantError("WORKSPACE_CONFIRMATION_REQUIRED", "当前目录没有工作区；请在交互终端运行 ffa 并确认创建路径。");
  const screen = new AssistantScreen();
  screen.setHeader("4-FIRE · 创建工作区");
  screen.setTranscript("新工作区只在明确确认后创建；取消不会留下工作区文件。");
  screen.onQuit = () => screen.stop();
  const interrupt = () => screen.stop();
  process.on("SIGINT", interrupt);
  try {
    screen.start();
    return await screen.choose(`是否在此路径创建工作区？\n${root}`, [
      { value: "cancel", label: "取消，不创建" }, { value: "create", label: "确认创建" },
    ]) === "create";
  } finally { process.off("SIGINT", interrupt); screen.stop(); }
}

export async function runInitialization(config: WorkspaceConfig, model: InitializationModel,
  save: (config: WorkspaceConfig) => Promise<void>, discovery?: InitializationDiscovery, memory?: MemoryPort): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new AssistantError("INITIALIZATION_REQUIRED", "工作区初始化尚未完成；请在交互终端运行 ffa 继续对话。");
  const screen = new AssistantScreen(undefined, {
    commands: ["help", "retry", "finish", "quit"], prompt: "输入回答",
    idleStatus: "初始化 · 直接回答或 Ctrl+P 打开菜单 · 接入不授权交易",
  });
  return runInitializationScreen(screen, config, model, save, discovery, memory);
}

/** Shares the analysis renderer and editor, but never exposes business execution tools. */
export async function runInitializationScreen(screen: AssistantScreen, config: WorkspaceConfig, model: InitializationModel,
  save: (config: WorkspaceConfig) => Promise<void>, discovery?: InitializationDiscovery, memory?: MemoryPort): Promise<boolean> {
  let waiting: ((text: string | undefined) => void) | undefined;
  let active: AbortController | undefined;
  const submit = (text: string) => {
    if (!text.trim()) return;
    if (text.trim() === "/quit") { screen.stop(); return; }
    if (!waiting) {
      screen.editor.setText(text);
      screen.notify("当前处理尚未结束；草稿已保留。可按 Esc 取消，或等待处理完成。");
      return;
    }
    screen.editor.addToHistory(text);
    screen.editor.setText("");
    if (!/^\/(?:help|retry|finish|quit)(?:\s|$)/.test(text.trim())) screen.appendMessage(text, "user");
    const done = waiting;
    waiting = undefined;
    screen.startWorking("正在保存初始化材料");
    done(text);
  };
  const work = async <T>(activity: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    active = controller;
    const signal = AbortSignal.any([screen.signal, controller.signal]);
    screen.stopWorking();
    screen.startWorking(activity);
    try {
      const result = await action(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted && !screen.signal.aborted) throw new AssistantError("SETUP_CANCELLED", "本次处理已取消，进度保留；可以补充信息或输入 /retry 重试整理。");
      throw error;
    } finally { active = undefined; screen.stopWorking(); }
  };
  screen.setHeader("4-FIRE · 工作区初始化");
  screen.setTranscript("");
  const history = config.messages.at(-1)?.role === "assistant" ? config.messages.slice(0, -1) : config.messages;
  for (const message of history) screen.appendMessage(message.text, message.role);
  screen.editor.onSubmit = submit;
  screen.onQuit = () => screen.stop();
  screen.onCancel = () => { if (active) active.abort(); };
  screen.onMenu = () => {
    if (!waiting) { screen.notify("请等待当前处理完成，或按 Esc 取消。"); return; }
    void (async () => {
      const command = await screen.choose("初始化操作", [
        { value: "/finish", label: "查看草案并确认完成" },
        { value: "/retry", label: "重新整理已保存材料" },
        { value: "/help", label: "命令帮助" },
        { value: "/quit", label: "保存进度退出" },
      ]);
      if (command) submit(command);
    })().catch(() => screen.notify("菜单未完成，请重试。"));
  };
  const closed = () => { waiting?.(undefined); waiting = undefined; };
  screen.signal.addEventListener("abort", closed, { once: true });
  const interrupt = () => screen.onCancel();
  process.on("SIGINT", interrupt);
  try {
    screen.start();
    return await initializeWorkspace(config, {
      respond: (messages, draft, _signal, tools) => work("AI 正在整理初始化材料", signal => model.respond(messages, draft, signal, tools)),
    }, {
      signal: screen.signal,
      show: (text, role) => role ? screen.appendMessage(text, role) : screen.notify(text),
      activity: text => { screen.stopWorking(); screen.startWorking(text); },
      ask: () => {
        screen.stopWorking();
        if (screen.signal.aborted) return Promise.resolve(undefined);
        return new Promise(resolve => { waiting = resolve; });
      },
      confirmDiscovery: async (source, entry, signal) => {
        screen.stopWorking();
        return await screen.choose(`来源：${source.name}\n将执行：${entry}\n外部程序及服务必须可信；帮助命令也可能产生副作用。此次仅发现，不授予业务操作权限。`, [
          { value: "back", label: "返回，不执行" }, { value: "inspect", label: "确认执行此次发现" },
        ], signal) === "inspect";
      },
      confirmAction: async (description, entry, signal) => {
        screen.stopWorking();
        return await screen.choose(`${description}\n${entry}\n此次确认不授予交易权限。`, [
          { value: "back", label: "返回，不执行" }, { value: "execute", label: "确认此次操作" },
        ], signal) === "execute";
      },
      confirm: async draft => {
        screen.stopWorking();
        const summary = formatInitializationDraft(draft);
        return await screen.choose(summary + "\n此确认保存本机连接和本工作区角色权限；仅启用完整约定；未来每次外部写入仍须精确确认。没有工具也可以完成基础初始化。", [
          { value: "back", label: "返回，继续补充" }, { value: "finish", label: "确认保存并完成初始化" },
        ]) === "finish";
      },
    }, save, discovery, memory);
  } catch (error) { if (screen.signal.aborted) return false; throw error; }
  finally {
    process.off("SIGINT", interrupt);
    screen.stop();
    screen.signal.removeEventListener("abort", closed);
    delete screen.editor.onSubmit;
  }
}

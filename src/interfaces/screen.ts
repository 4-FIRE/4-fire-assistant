import { Container, Editor, Input, Markdown, ProcessTerminal, ScrollView, SelectList, Spacer, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, MarkdownTheme, SelectItem, Terminal } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { CommittedView } from "../application/ports.js";

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
const accent = (text: string) => `\x1b[36m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const theme = { selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: dim };
const markdownTheme: MarkdownTheme = {
  heading: bold, link: accent, linkUrl: dim, code: accent, codeBlock: text => text,
  codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: dim, bold,
  italic: text => `\x1b[3m${text}\x1b[23m`,
  strikethrough: text => `\x1b[9m${text}\x1b[29m`,
  underline: text => `\x1b[4m${text}\x1b[24m`,
};
function messageText(text: string): string {
  return terminalText(text).replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
}
class MessageBlock implements Component {
  private readonly content: Text | Markdown;
  constructor(private text: string, private readonly role?: "user" | "assistant", private streaming = false) {
    // Dollar amounts must remain text instead of being parsed as LaTeX.
    this.content = role === "assistant" ? new Markdown(text, 0, 0, markdownTheme, undefined, { renderLatex: false }) : new Text(text, 0, 0);
  }
  setText(text: string, streaming = false): void {
    if (text !== this.text) { this.text = text; this.content.setText(text); }
    this.streaming = streaming;
  }
  invalidate(): void { this.content.invalidate(); }
  render(width: number): string[] {
    if (!this.text.trim()) return [];
    if (!this.role) return this.content.render(width).map(dim);
    const label = this.role === "user" ? accent(bold("❯ 用户")) : bold(`● 助手${this.streaming ? " · 正在回答" : ""}`);
    const prefix = width > 2 ? (this.role === "user" ? accent("│ ") : "  ") : "";
    const lines = this.content.render(Math.max(1, width - (prefix ? 2 : 0))).slice();
    // Markdown can add a final paragraph spacer. Keep one gap between message blocks.
    while (lines.length && !terminalText(lines[lines.length - 1]!).trim()) lines.pop();
    return [truncateToWidth(label, width), ...lines.map(line => prefix + line)];
  }
}
class StatusLine implements Component {
  constructor(private text: string) {}
  setText(text: string): void { this.text = text; }
  invalidate(): void {}
  render(width: number): string[] { return [truncateToWidth(this.text.replace(/\s*\n\s*/g, " "), width)]; }
}
class PromptEditor extends Editor {
  prompt = "输入目标";
  protected override renderTopBorder(width: number): string {
    return accent(truncateToWidth(`❯ ${this.prompt}或命令 ` + "─".repeat(width), width, ""));
  }
}
const commands = ["help", "status", "experts", "intents", "confirm", "decline", "resolve", "revoke", "new", "resume", "continue", "cancel", "configure", "quit"];
const idleStatus = "就绪 · 输入目标或 /help · 分析不等于交易许可";
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One renderer owns the terminal, including asynchronous notices and control dialogs. */
export class AssistantScreen {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private readonly header = new StatusLine("4-FIRE · 交易研究助手");
  private readonly body = new Container();
  private readonly status = new StatusLine("就绪");
  private readonly hint = new StatusLine("Enter 发送 · Shift+Enter 换行 · Ctrl+P 打开菜单 · Esc 取消工作 · Ctrl+D 退出");
  private readonly scroll: ScrollView;
  private document: { id: string; block: MessageBlock }[] = [];
  private session = "";
  private noticeId = 0;
  private cancelDialog: (() => void) | undefined;
  private stopped = false;
  private controlDepth = 0;
  private workingSince: number | undefined;
  private activity = "正在处理";
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  onCancel: () => void = () => {};
  onQuit: () => void = () => {};
  onMenu: () => void = () => {};

  constructor(terminal: Terminal = new ProcessTerminal(), private readonly options: {
    commands?: readonly string[]; idleStatus?: string; prompt?: string;
  } = {}) {
    this.body.addChild(new Text("输入目标开始对话。按 Ctrl+P 打开操作菜单。", 0, 0));
    this.tui = new TuiAltScreen(terminal, true, undefined, { mouse: false });
    const editor = new PromptEditor(this.tui, { borderColor: accent, selectList: theme }, { paddingX: 1 });
    editor.prompt = options.prompt ?? "输入目标";
    this.editor = editor;
    this.editor.setAutocompleteProvider({
      triggerCharacters: ["/"],
      getSuggestions: async (lines, row, col) => {
        const prefix = lines[row]?.slice(0, col) ?? "";
        if (row !== 0 || !/^\/\w*$/.test(prefix)) return null;
        return { prefix, items: (options.commands ?? commands).filter(command => `/${command}`.startsWith(prefix)).map(command => ({ value: `/${command}`, label: `/${command}` })) };
      },
      applyCompletion: (lines, row, col, item, prefix) => ({
        lines: lines.map((line, index) => index === row ? line.slice(0, col - prefix.length) + item.value + " " + line.slice(col) : line),
        cursorLine: row, cursorCol: col - prefix.length + item.value.length + 1,
      }),
    });
    this.scroll = new ScrollView(this.body, { follow: "end", primary: true });
    this.tui.setLayoutRoot(new VStack([
      { component: this.header, shrink: 0 },
      { component: this.scroll, grow: 1, basis: 0, minSize: 1 },
      { component: this.status, shrink: 0 },
      { component: this.editor, shrink: 0, maxSize: 8 },
      { component: this.hint, shrink: 0 },
    ]));
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (matchesKey(data, "ctrl+d")) { this.onQuit(); return { consume: true }; }
      if (this.cancelDialog) {
        if (matchesKey(data, "ctrl+c")) { this.cancelDialog(); return { consume: true }; }
        return undefined;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.onCancel(); return { consume: true }; }
      if (this.controlDepth) return { consume: true };
      if (matchesKey(data, "ctrl+p")) { this.onMenu(); return { consume: true }; }
      return undefined;
    });
  }
  start(): void { this.tui.start(); }
  suspendInput(): () => void {
    this.controlDepth++;
    return () => { this.controlDepth--; };
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopWorking();
    this.controller.abort();
    this.cancelDialog?.();
    this.tui.stop();
  }
  setHeader(text: string): void { this.header.setText(accent(terminalText(text))); this.tui.requestRender(); }
  setStatus(text: string): void { this.status.setText(dim(terminalText(text))); this.tui.requestRender(); }
  startWorking(activity: string): boolean {
    if (this.stopped || this.workingSince !== undefined) return false;
    this.workingSince = performance.now();
    this.activity = activity;
    this.renderProgress();
    this.progressTimer = setInterval(() => this.renderProgress(), 100);
    this.progressTimer.unref();
    return true;
  }
  stopWorking(): void {
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
    this.workingSince = undefined;
    this.setStatus(this.options.idleStatus ?? idleStatus);
  }
  private renderProgress(): void {
    if (this.workingSince === undefined) return;
    const elapsed = Math.max(0, performance.now() - this.workingSince);
    const seconds = Math.floor(elapsed / 1000);
    const duration = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    this.setStatus(`${spinner[Math.floor(elapsed / 100) % spinner.length]} ${duration} · ${this.activity} · Esc 取消工作 · 分析不等于交易许可`);
  }
  setTranscript(text: string): void {
    const content = messageText(text);
    this.document = content.trim() ? [{ id: "intro", block: new MessageBlock(content) }] : [];
    this.refreshBody();
  }
  setConversation(view: CommittedView): void {
    if (view.conversation.id !== this.session) {
      this.session = view.conversation.id;
      this.document = [];
      this.scroll.scrollToEnd();
    }
    const entries = new Map(this.document.map(entry => [entry.id, entry]));
    for (const message of view.messages) {
      const id = `message:${message.id}`;
      const text = messageText(message.text);
      // Tool calls and reasoning can commit assistant messages without visible text.
      if (!text.trim()) continue;
      const existing = entries.get(id);
      if (existing) { existing.block.setText(text); continue; }
      const partial = this.document.find(entry => entry.id === "partial");
      if (message.role === "assistant" && partial) {
        partial.id = id;
        partial.block.setText(text);
        entries.set(id, partial);
      } else {
        const entry = { id, block: new MessageBlock(text, message.role) };
        this.document.push(entry);
        entries.set(id, entry);
      }
    }
    const partial = this.document.find(entry => entry.id === "partial");
    const text = messageText(view.partial);
    if (text.trim()) {
      if (partial) partial.block.setText(text, true);
      else this.document.push({ id: "partial", block: new MessageBlock(text, "assistant", true) });
    } else this.document = this.document.filter(entry => entry.id !== "partial");
    this.refreshBody();
    if (view.working) this.activity = view.activity ?? (view.partial.trim() ? "正在回答" : "正在处理");
    if (this.workingSince !== undefined) this.renderProgress();
    else this.setStatus(this.options.idleStatus ?? idleStatus);
  }
  appendMessage(text: string, role: "user" | "assistant"): void {
    const content = messageText(text);
    if (!content.trim()) return;
    this.document.push({ id: `message:${++this.noticeId}`, block: new MessageBlock(content, role) });
    this.refreshBody();
  }
  notify(text: string): void {
    const content = messageText(text);
    if (!content.trim()) return;
    this.document.push({ id: `notice:${++this.noticeId}`, block: new MessageBlock(content) });
    this.refreshBody();
    if (this.workingSince === undefined) this.setStatus(text);
  }
  private refreshBody(): void {
    this.body.clear();
    for (const [index, entry] of this.document.entries()) {
      if (index) this.body.addChild(new Spacer(1));
      this.body.addChild(entry.block);
    }
    if (!this.document.length) this.body.addChild(new Text("输入目标开始对话。按 Ctrl+P 打开操作菜单。", 0, 0));
    this.tui.requestRender();
  }
  get dialogOpen(): boolean { return this.cancelDialog !== undefined; }

  private dialogContentHeight(): number {
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85));
    const framed = Math.floor(this.tui.terminal.columns * 0.9) >= 6 && height >= 5;
    return Math.max(1, height - (framed ? 2 : 0));
  }

  private dialog<T>(component: Component & Focusable, connect: (done: (value: T | undefined) => void) => void): Promise<T | undefined> {
    if (this.stopped || this.cancelDialog) return Promise.resolve(undefined);
    // One full-viewport overlay masks the transcript, status and inactive editor.
    // The dialog itself remains centered; blank cells are opaque, not transparent.
    const modal: Component & Focusable = {
      get focused() { return component.focused; },
      set focused(value) { component.focused = value; },
      render: width => {
        const height = this.tui.terminal.rows;
        const panelWidth = Math.max(1, Math.floor(width * 0.9));
        const framed = panelWidth >= 6 && Math.floor(height * 0.85) >= 5;
        const contentWidth = Math.max(1, panelWidth - (framed ? 4 : 0));
        const content = component.render(contentWidth).slice(0, this.dialogContentHeight());
        const panel = framed ? [
          accent(`╭${"─".repeat(panelWidth - 2)}╮`),
          ...content.map(line => accent("│") + " " + truncateToWidth(line, contentWidth, "", true) + " " + accent("│")),
          accent(`╰${"─".repeat(panelWidth - 2)}╯`),
        ] : content.map(line => truncateToWidth(line, panelWidth, "", true));
        const top = Math.max(0, Math.floor((height - panel.length) / 2));
        const left = " ".repeat(Math.max(0, Math.floor((width - panelWidth) / 2)));
        return Array.from({ length: height }, (_, row) =>
          "\x1b[0m" + truncateToWidth(panel[row - top] === undefined ? "" : left + panel[row - top], width, "", true));
      },
      invalidate: () => component.invalidate(),
      handleInput: data => component.handleInput?.(data),
    };
    return new Promise(resolve => {
      const overlay = this.tui.showOverlay(modal, { width: "100%", maxHeight: "100%" });
      const done = (value: T | undefined) => {
        this.cancelDialog = undefined;
        overlay.hide();
        this.tui.requestRender();
        resolve(value);
      };
      this.cancelDialog = () => done(undefined);
      connect(done);
      this.tui.requestRender();
    });
  }

  async choose(title: string, items: SelectItem[], signal?: AbortSignal, options: { filter?: boolean } = {}): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    const search = new Input({ prompt: "筛选 > " });
    const choices = items.map(item => ({ ...item, label: terminalText(item.label), ...(item.description ? { description: terminalText(item.description) } : {}) }));
    let complete: (value: string | undefined) => void = () => {};
    let listRows = 8;
    let titleOffset = 0;
    const filtered = () => choices.filter(item => `${item.label} ${item.description ?? ""} ${item.value}`.toLowerCase().includes(search.getValue().toLowerCase()));
    const createList = () => {
      const list = new SelectList(filtered(), listRows, theme);
      list.onSelect = item => complete(item.value);
      list.onCancel = () => complete(undefined);
      return list;
    };
    let list = createList();
    const label = new Text(terminalText(title), 1, 0);
    const component: Component & Focusable = {
      get focused() { return search.focused; },
      set focused(value) { search.focused = value; },
      render: width => {
        const height = this.dialogContentHeight();
        const showSearch = options.filter !== false && height >= 5, showHint = height >= 3, showCounter = height >= 6;
        const controls = Number(showSearch) + Number(showHint) + Number(showCounter);
        const lines = label.render(width);
        const titleRows = Math.min(lines.length, Math.max(0, Math.min(Math.floor(height / 2), height - controls - 1)));
        titleOffset = Math.max(0, Math.min(titleOffset, lines.length - titleRows));
        const available = Math.max(1, Math.min(8, height - titleRows - controls));
        if (available !== listRows) {
          const selected = list.getSelectedItem()?.value;
          listRows = available;
          list = createList();
          list.setSelectedIndex(Math.max(0, filtered().findIndex(item => item.value === selected)));
        }
        return [...lines.slice(titleOffset, titleOffset + titleRows), ...(showSearch ? search.render(width) : []),
          ...list.render(width).slice(0, available + Number(showCounter)),
          ...(showHint ? [truncateToWidth(lines.length > titleRows ? "PgUp/PgDn 查看说明 · Enter 确认 · Esc 返回" : `↑↓ 选择 · Enter 确认${options.filter !== false ? " · 输入文字筛选" : ""} · Esc 返回`, width)] : [])];
      },
      invalidate: () => { label.invalidate(); search.invalidate(); list.invalidate(); },
      handleInput: data => {
        if (matchesKey(data, "pageUp")) titleOffset -= 2;
        else if (matchesKey(data, "pageDown")) titleOffset += 2;
        else if ((["up", "down", "enter", "escape"] as const).some(key => matchesKey(data, key))) list.handleInput(data);
        else if (options.filter !== false) { search.handleInput(data); list = createList(); }
        this.tui.requestRender();
      },
    };
    const abort = () => this.cancelDialog?.();
    signal?.addEventListener("abort", abort, { once: true });
    try { return await this.dialog<string>(component, done => { complete = done; }); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  async ask(title: string, initial = "", secret = false, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    const input = new Input({ prompt: "> " });
    input.setValue(initial);
    const label = new Text(terminalText(title), 1, 0);
    let titleOffset = 0;
    const component: Component & Focusable = {
      get focused() { return input.focused; },
      set focused(value) { input.focused = value; },
      render: width => {
        const height = this.dialogContentHeight(), showHint = height >= 3;
        const lines = label.render(width);
        const rows = Math.max(0, height - 1 - Number(showHint));
        titleOffset = Math.max(0, Math.min(titleOffset, lines.length - Math.min(rows, lines.length)));
        return [...lines.slice(titleOffset, titleOffset + rows), ...(secret ? [truncateToWidth(`> ${"•".repeat(Math.min(32, Array.from(input.getValue()).length))} [隐藏输入]`, width)] : input.render(width)),
          ...(showHint ? [truncateToWidth(lines.length > rows ? "PgUp/PgDn 查看说明 · Enter 确认 · Esc 返回" : "Enter 确认 · Esc 返回", width)] : [])];
      },
      invalidate: () => { label.invalidate(); input.invalidate(); },
      handleInput: data => {
        if (matchesKey(data, "pageUp")) titleOffset -= 2;
        else if (matchesKey(data, "pageDown")) titleOffset += 2;
        else input.handleInput(data);
        this.tui.requestRender();
      },
    };
    const abort = () => this.cancelDialog?.();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.dialog<string>(component, done => {
        input.onSubmit = value => { input.setValue(""); done(value); };
        input.onEscape = () => { input.setValue(""); done(undefined); };
      });
    } finally { input.setValue(""); signal?.removeEventListener("abort", abort); }
  }
}

import { createInterface, emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { TerminalApproval } from "./approval.js";
import { AssistantError, type CommittedView, type RuntimePort, type RuntimeStatus } from "../application/ports.js";
import { AssistantScreen, terminalText } from "./screen.js";
export { terminalText } from "./screen.js";

type Input = Readable & { isTTY?: boolean };
type Output = Writable & { isTTY?: boolean };
export function userError(error: unknown): string {
  return error instanceof AssistantError ? `[${error.code}] ${terminalText(error.message)}` :
    "操作失败。已保存的记录仍保留。请用 /status 查看状态。必要时重新启动应用。";
}
/** Only consumes committed views. It is not an audit log. */
export class CommittedRenderer {
  private session = "";
  private seen = new Set<string>();
  private partial = "";
  constructor(private readonly write: (text: string) => void) {}
  render(view: CommittedView): void {
    if (this.session !== view.conversation.id) {
      this.session = view.conversation.id;
      this.seen.clear();
      this.partial = "";
      this.write(`\n会话 ${view.conversation.id}：${terminalText(view.conversation.title)}\n`);
    }
    for (const message of view.messages) {
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (!terminalText(message.text).trim()) continue;
      if (message.role === "assistant" && this.partial && message.text.startsWith(this.partial)) {
        this.write(terminalText(message.text.slice(this.partial.length)) + "\n");
        this.partial = "";
      } else {
        this.write(`\n${message.role === "user" ? "用户" : "助手"}：${terminalText(message.text)}\n`);
        if (message.role === "assistant") this.partial = "";
      }
    }
    if (terminalText(view.partial).trim() && view.partial !== this.partial) {
      if (!this.partial) this.write("\n助手：");
      else if (!view.partial.startsWith(this.partial)) this.write("\n[已保存的回答已更新]\n");
      this.write(terminalText(view.partial.startsWith(this.partial) ? view.partial.slice(this.partial.length) : view.partial));
      this.partial = view.partial;
    }
    if (!view.working && !terminalText(view.partial).trim() && this.partial) { this.write("\n"); this.partial = ""; }
  }
}
export class TerminalAdapter {
  private stopWatch: (() => Promise<void>) | undefined;
  private readonly renderer: CommittedRenderer;
  private readonly jobs = new Set<Promise<unknown>>();
  private screen: AssistantScreen | undefined;
  private working = false;
  constructor(private readonly application: RuntimePort,
    private readonly input: Input = process.stdin, private readonly output: Output = process.stdout, private readonly approval?: TerminalApproval,
    private readonly options: { configure?: (screen: AssistantScreen) => Promise<void>; model?: string; initializing?: () => boolean; screenFactory?: () => AssistantScreen } = {}) {
    this.renderer = new CommittedRenderer(text => { this.output.write(text); });
  }
  private write(text: string) {
    if (this.screen) this.screen.notify(text);
    else this.output.write(terminalText(text) + "\n");
  }
  notify(text: string): void { this.write(text); }
  private async attach(): Promise<void> {
    await this.stopWatch?.();
    this.stopWatch = await this.application.observe(view => {
      this.working = view.working;
      if (!this.screen) { this.renderer.render(view); return; }
      this.screen.setHeader(`4-FIRE · ${this.options.model ?? "交易助手"} · ${view.conversation.title}`);
      this.screen.setConversation(view);
    });
  }
  private async dispatch(line: string, quit: () => void): Promise<void> {
    const text = line.trim();
    if (!text) return;
    if (!text.startsWith("/")) {
      const started = this.screen?.startWorking("正在提交请求");
      try {
        const result = await this.application.submit(line);
        this.write(`[回答状态：${result.status}] 此状态不表示交易结果。`);
      } finally { if (started) this.screen?.stopWorking(); }
      return;
    }
    const space = text.indexOf(" ");
    const command = space === -1 ? text : text.slice(0, space);
    const argument = space === -1 ? "" : text.slice(space + 1).trim();
    switch (command) {
      case "/quit": quit(); return;
      case "/help":
        this.write([
          "命令帮助：尖括号表示必填参数，方括号表示可选参数。输入时不要包含括号。",
          "/help — 查看命令帮助。",
          "/status — 查看会话状态、未完成任务和交易状态。",
          "/experts — 查看专家任务。",
          "/intents — 查看交易意图及其状态。",
          "/confirm <ID> <VERSION> — 确认当前窗口中的操作版本和全部参数。程序仍须检查发送条件。",
          "/decline <ID> <VERSION> — 拒绝当前窗口中的操作版本。",
          "/resolve <ID> <VERSION> <核对依据> — 人工结案结果不明的交易。此命令不执行或重发交易。",
          "ID 和 VERSION 必须与当前记录一致。VERSION 是版本号。",
          "/revoke — 撤销所有尚未使用的交易许可。此命令不撤销已发送的订单。",
          "/new [名称] — 新建会话。留空使用默认名称。",
          "/resume [会话ID] — 切换会话。留空显示会话列表。",
          "/continue — 确认继续当前会话中未完成的工作。",
          "/cancel — 取消当前工作。此命令不撤销已发送的订单。",
          "/configure — 打开应用配置。请先完成或取消当前工作。",
          "/quit — 退出应用并保留未完成的工作。重新启动后，用 /continue 确认继续。",
          "对话快捷键：Enter 发送；Shift+Enter 换行；Ctrl+P 打开菜单；Ctrl+D 退出。",
          "在对话页面按 Esc 或 Ctrl+C 取消工作。在确认窗口中按这两个键拒绝本次操作。",
          "分析不等于交易许可。真实交易需要独立复核和用户确认。",
        ].join("\n"));
        return;
      case "/status":
        { const status = await this.application.status();
          this.write(this.screen ? `会话：${status.conversation.title} (${status.conversation.id})\n工作状态：${status.work?.status ?? "空闲"} · 未完成任务：${status.unfinishedTasks}\n需要恢复：${status.needsContinuation ? "是，使用 /continue" : "否"}\n无法恢复的原因：${status.blocked.join("、") || "无"}\n${status.business ? JSON.stringify(status.business, null, 2) : ""}\n${status.usage ? `模型用量：${JSON.stringify(status.usage, null, 2)}` : ""}` : JSON.stringify(status, null, 2)); return; }
      case "/continue": {
        const started = this.screen?.startWorking("正在恢复工作");
        try { this.write(`[回答状态：${(await this.application.continueWork()).status}] 此状态不表示交易结果。`); }
        finally { if (started) this.screen?.stopWorking(); }
        return;
      }
      case "/cancel":
        await this.application.cancel(); this.write("[当前工作已取消。此操作不会撤销已发送的订单。]"); return;
      case "/new":
        await this.application.newSession(argument || undefined); await this.attach(); return;
      case "/resume":
        if (!argument && this.screen) {
          const sessions = await this.application.sessions();
          const id = await this.screen.choose("选择会话", sessions.map(session => ({ value: session.id, label: session.title, description: session.id })));
          if (id) { await this.application.selectSession(id); await this.attach(); }
        } else if (!argument) this.write(JSON.stringify(await this.application.sessions(), null, 2));
        else { await this.application.selectSession(argument); await this.attach(); }
        return;
      case "/configure":
        if (this.screen && this.options.configure) {
          const status = await this.application.status();
          if (status.unfinishedTasks || status.needsContinuation || this.working) throw new AssistantError("WORK_BUSY", "请先完成或取消当前工作，再修改配置。");
          await this.options.configure(this.screen);
        } else this.write("使用 --configure 打开配置向导。也可用 --configure-file <绝对路径> 导入配置。请通过环境变量或独立的隐藏输入框提供凭证。不要把凭证发送到对话。");
        return;
      case "/experts": this.write(JSON.stringify(await this.application.experts(), null, 2)); return;
      case "/intents": this.write(JSON.stringify(await this.application.intents(), null, 2)); return;
      case "/confirm":
      case "/decline": {
        const values = argument.split(/\s+/);
        if (!this.approval || values.length !== 2 || !/^[1-9]\d*$/.test(values[1]!)) throw new AssistantError("APPROVAL_COMMAND", "请在交互终端输入 /confirm <ID> <VERSION> 或 /decline <ID> <VERSION>。参数必须与当前确认窗口一致。对话中的确认无效。");
        this.approval.respond(values[0]!, Number(values[1]), command === "/confirm"); this.write(command === "/confirm" ? "[已确认当前版本和全部参数。程序仍须检查发送条件，确认不表示已发送。]" : "[已拒绝]"); return;
      }
      case "/resolve": {
        if (!this.input.isTTY || !this.output.isTTY) throw new AssistantError("RESOLUTION_NEEDS_TTY", "请在交互终端使用 /resolve 人工结案。");
        const match = /^(\S+)\s+([1-9]\d*)\s+([\s\S]+)$/.exec(argument);
        if (!match || !Number.isSafeInteger(Number(match[2]))) throw new AssistantError("RESOLUTION_COMMAND", "请使用 /resolve <ID> <VERSION> <核对依据>。此命令仅解除结果不明的交易限制，不执行或重发交易。");
        this.write(JSON.stringify(await this.application.resolveIntent(match[1]!, Number(match[2]), match[3]!), null, 2));
        return;
      }
      case "/revoke": await this.application.revoke(); this.approval?.revoke(); this.write("[所有尚未使用的交易许可已撤销。此操作不会撤销已发送的操作。]"); return;
      default: throw new AssistantError("UNKNOWN_COMMAND", "命令不存在。请用 /help 查看命令。");
    }
  }
  private showStartup(status: RuntimeStatus): void {
    if (status.needsContinuation) this.write(`未完成任务：${status.work?.content ?? status.work?.requestId}。使用 /continue 确认继续，或用 /cancel 取消。`);
    if (this.options.initializing?.()) this.write("工作区尚未完成初始化。请提供目标市场和数据服务资料。交易服务为可选项。");
    if (status.blocked.length) this.write("无法恢复工作。记录已保留，工作尚未开始。请用 /status 查看原因。");
    const business = status.business;
    if (business && typeof business === "object" && !Array.isArray(business)) {
      const execution = business.execution;
      if (execution && typeof execution === "object" && !Array.isArray(execution) && Array.isArray(execution.unsettled) && execution.unsettled.length) {
        this.write("工作区有待核对的交易。程序已禁止新的交易写入。仍可查询数据和开展研究。\n" + JSON.stringify(execution.unsettled, null, 2));
      }
    }
  }
  async run(once?: () => Promise<unknown>): Promise<void> {
    if (!once && (this.options.screenFactory || this.input === process.stdin && this.output === process.stdout && this.input.isTTY && this.output.isTTY && process.env.TERM !== "dumb")) {
      await this.runScreen(once); return;
    }
    this.write("4-FIRE Assistant — 交易研究助手。分析不等于交易许可。");
    await this.attach();
    const status = await this.application.status();
    this.showStartup(status);
    const rl = createInterface({ input: this.input, output: this.output,
      terminal: Boolean(this.input.isTTY && this.output.isTTY) });
    const interrupt = () => {
      const job = this.application.cancel().then(() => this.write("[当前工作已取消。此操作不会撤销已发送的订单。]"), error => this.write(userError(error)));
      this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
    };
    const keypress = (_text: string, key: { name?: string }) => { if (key?.name === "escape") interrupt(); };
    emitKeypressEvents(this.input, rl);
    this.input.on("keypress", keypress);
    rl.on("SIGINT", interrupt);
    process.on("SIGINT", interrupt);
    try {
      if (this.input.isTTY) {
        rl.on("line", line => {
          const job = this.dispatch(line, () => rl.close()).catch(error => this.write(userError(error)));
          this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
        });
        await new Promise<void>(resolve => {
          rl.once("close", resolve);
          if (once) {
            const job = once().catch(error => this.write(userError(error))).finally(() => rl.close());
            this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
          }
        });
      } else {
        // Explicit batch input is sequential; the SDK never queues follow-ups.
        if (once) await once();
        else for await (const line of rl) {
          if (line.trim() === "/quit") break;
          try { await this.dispatch(line, () => rl.close()); } catch (error) { this.write(userError(error)); }
        }
      }
    } finally {
      this.input.off("keypress", keypress);
      rl.off("SIGINT", interrupt);
      process.off("SIGINT", interrupt);
      rl.close();
      await this.stopWatch?.();
      await this.application.close();
      await Promise.allSettled([...this.jobs]);
    }
  }

  private async runScreen(once?: () => Promise<unknown>): Promise<void> {
    const screen = this.options.screenFactory?.() ?? new AssistantScreen();
    this.screen = screen;
    let closing = false;
    let finish!: () => void;
    const closed = new Promise<void>(resolve => { finish = resolve; });
    const quit = () => { closing = true; finish(); };
    const launch = (action: () => Promise<unknown>) => {
      if (closing) return;
      const job = action().catch(error => this.write(userError(error)));
      this.jobs.add(job);
      void job.finally(() => this.jobs.delete(job));
    };
    let sending = false;
    screen.editor.onSubmit = text => {
      if (!text.trim()) return;
      if (!text.trim().startsWith("/") && (sending || this.working)) {
        screen.editor.setText(text);
        screen.notify("当前请求尚未结束。输入草稿已保留。请等待回答完成，或按 Esc 取消当前工作。");
        return;
      }
      screen.editor.addToHistory(text);
      screen.editor.setText("");
      if (!text.trim().startsWith("/")) sending = true;
      launch(async () => {
        try { await this.dispatch(text, quit); }
        catch (error) {
          if (!text.trim().startsWith("/") && !screen.editor.getText()) screen.editor.setText(text);
          throw error;
        }
        finally { if (!text.trim().startsWith("/")) sending = false; }
      });
    };
    screen.onCancel = () => launch(async () => { await this.application.cancel(); this.write("当前工作已取消。此操作不会撤销已发送的订单。"); });
    screen.onQuit = quit;
    screen.onMenu = () => launch(async () => {
      const command = await screen.choose("操作菜单", [
        ["/new", "新建会话"], ["/resume", "切换会话"], ["/status", "查看状态"], ["/continue", "恢复未完成工作"],
        ["/cancel", "取消当前工作"], ["/experts", "查看专家任务"], ["/intents", "查看交易意图"],
        ["/revoke", "撤销未使用的交易许可"], ["/configure", "打开应用配置"], ["/help", "命令帮助"], ["/quit", "退出并保留未完成工作"],
      ].map(([value, label]) => ({ value: value!, label: label!, description: value! })));
      if (command) {
        if (command === "/new") {
          const title = await screen.ask("新会话名称（留空使用默认名称）");
          if (title === undefined) return;
          await this.dispatch(`/new ${title}`, quit);
        } else await this.dispatch(command, quit);
      }
    });
    const interrupt = () => screen.onCancel();
    process.on("SIGINT", interrupt);
    try {
      screen.start();
      this.approval?.attachScreen(screen);
      await this.attach();
      const status = await this.application.status();
      this.showStartup(status);
      if (once) launch(async () => { try { await once(); } finally { quit(); } });
      await closed;
    } finally {
      closing = true;
      process.off("SIGINT", interrupt);
      this.approval?.revoke();
      this.approval?.attachScreen(undefined);
      screen.stop();
      await this.stopWatch?.();
      await this.application.close();
      await Promise.allSettled([...this.jobs]);
      this.screen = undefined;
    }
  }
}

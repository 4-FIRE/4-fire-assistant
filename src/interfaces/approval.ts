import type { ApprovalInteraction, Confirmation } from "../application/execution.js";
import { AssistantError } from "../application/ports.js";
import { terminalText, type AssistantScreen } from "./screen.js";
import { randomUUID } from "node:crypto";

/** Only the terminal control router owns this object; model tools never receive it. */
export class TerminalApproval implements ApprovalInteraction {
  readonly #pending = new Map<string, { revision: number; finish: (accepted: boolean) => void }>();
  private screen: AssistantScreen | undefined;
  private dialogs: Promise<void> = Promise.resolve();
  attachScreen(screen: AssistantScreen | undefined): void { this.screen = screen; }
  constructor(private readonly write: (text: string) => void = text => { process.stdout.write(text); },
    private readonly tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)) {}
  confirmAction(description: string, entry: string, signal?: AbortSignal): Promise<boolean> {
    return this.request(randomUUID(), 1, "确认本机操作：此确认不授予交易许可", `${description}\n${entry}`, signal);
  }
  confirm(confirmation: Confirmation, signal?: AbortSignal): Promise<boolean> {
    const snapshot = structuredClone(confirmation);
    return this.request(snapshot.intentId, snapshot.revision, "确认交易写入：模型不能代替用户授权", JSON.stringify(snapshot, null, 2), signal);
  }
  private request(id: string, revision: number, title: string, body: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.tty) throw new AssistantError("APPROVAL_NEEDS_TTY", "非交互模式不能取得交易许可。提示词和历史记录不能代替确认。请在交互终端确认当前版本和全部参数。");
    signal?.throwIfAborted();
    if (this.#pending.has(id)) throw new AssistantError("APPROVAL_BUSY", "此操作正在等待确认。");
    return new Promise(resolve => {
      const controller = new AbortController();
      const abort = () => finish(false);
      const finish = (accepted: boolean) => {
        if (controller.signal.aborted) return;
        this.#pending.delete(id);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        resolve(accepted);
      };
      this.#pending.set(id, { revision, finish });
      signal?.addEventListener("abort", abort, { once: true });
      const details = terminalText(`[${title}]\n${body}\n此确认仅适用于本次操作的当前版本和以上全部参数。`);
      const fallback = () => {
        this.write(`\n${details}\n`);
        this.write(`/confirm ${id} ${revision}\n/decline ${id} ${revision}\n/revoke 撤销所有尚未使用的交易许可。\nEsc 取消当前工作，但不撤销已发送的订单。\n`);
      };
      if (signal?.aborted) { finish(false); return; }
      if (!this.screen) { fallback(); return; }
      this.dialogs = this.dialogs.then(async () => {
        if (controller.signal.aborted) return;
        const screen = this.screen;
        // Keep the command route available if another control dialog owns input.
        if (!screen || screen.dialogOpen) { fallback(); return; }
        const choice = await screen.choose(`${details}\n按 Esc 拒绝本次操作。此操作不会撤销已发送的订单。`, [
          { value: "decline", label: "拒绝本次操作" },
          { value: "confirm", label: "确认本次操作", description: "仅确认以上全部参数，不授权后续操作" },
        ], controller.signal, { filter: false });
        finish(choice === "confirm");
      }).catch(() => finish(false));
    });
  }
  respond(id: string, revision: number, accepted: boolean): void {
    const pending = this.#pending.get(id);
    if (!this.tty || !pending || pending.revision !== revision) throw new AssistantError("APPROVAL_MISMATCH", "没有与此 ID 和版本匹配的确认窗口。历史命令不能恢复许可。");
    pending.finish(accepted);
  }
  revoke(): void { for (const pending of [...this.#pending.values()]) pending.finish(false); }
}

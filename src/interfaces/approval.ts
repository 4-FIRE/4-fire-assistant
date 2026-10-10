import type { ApprovalInteraction, Confirmation } from "../application/execution.js";
import { AssistantError } from "../application/ports.js";
import { terminalText } from "./terminal.js";
import { randomUUID } from "node:crypto";

/** Only the terminal control router owns this object; model tools never receive it. */
export class TerminalApproval implements ApprovalInteraction {
  readonly #pending = new Map<string, { revision: number; finish: (accepted: boolean) => void }>();
  constructor(private readonly write: (text: string) => void = text => { process.stdout.write(text); },
    private readonly tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)) {}
  confirmAction(description: string, entry: string, signal?: AbortSignal): Promise<boolean> {
    return this.request(randomUUID(), 1, "本机操作确认：不是交易许可", `${description}\n${entry}`, signal);
  }
  confirm(confirmation: Confirmation, signal?: AbortSignal): Promise<boolean> {
    const snapshot = structuredClone(confirmation);
    return this.request(snapshot.intentId, snapshot.revision, "精确写入确认：不是模型授权", JSON.stringify(snapshot, null, 2), signal);
  }
  private request(id: string, revision: number, title: string, body: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.tty) throw new AssistantError("APPROVAL_NEEDS_TTY", "非交互模式不能从提示词/历史取得交易许可；请在交互终端对当前完整参数确认。");
    signal?.throwIfAborted();
    if (this.#pending.has(id)) throw new AssistantError("APPROVAL_BUSY", "该操作已有确认窗口。");
    return new Promise(resolve => {
      const abort = () => finish(false);
      const finish = (accepted: boolean) => { this.#pending.delete(id); signal?.removeEventListener("abort", abort); resolve(accepted); };
      this.#pending.set(id, { revision, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.write(terminalText(`\n[${title}]\n${body}\n`));
      this.write(`仅授权上面这一次版本和全部实际参数。\n/confirm ${id} ${revision}\n/decline ${id} ${revision}\n/revoke 撤销当前所有未消费许可；Esc 取消工作但不撤销外部订单。\n`);
      if (signal?.aborted) finish(false);
    });
  }
  respond(id: string, revision: number, accepted: boolean): void {
    const pending = this.#pending.get(id);
    if (!this.tty || !pending || pending.revision !== revision) throw new AssistantError("APPROVAL_MISMATCH", "没有这个当前意图/版本的确认窗口；历史命令不会恢复许可。");
    pending.finish(accepted);
  }
  revoke(): void { for (const pending of [...this.#pending.values()]) pending.finish(false); }
}

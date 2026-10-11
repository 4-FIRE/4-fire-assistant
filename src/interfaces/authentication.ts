import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { Writable } from "node:stream";
import { AssistantError, type AuthenticationInteraction } from "../application/ports.js";
import { terminalText } from "./terminal.js";

/** Separate control-plane input. Keys/codes are neither model messages nor terminal history. */
export function terminalAuthentication(): AuthenticationInteraction & { dispose(): void } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AssistantError("LOGIN_NEEDS_TTY", "登录需要交互终端。非交互模式请使用提供商支持的环境变量。不要把凭证发送到对话。");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  return {
    signal: controller.signal,
    notify: message => { process.stdout.write(terminalText(message) + "\n"); },
    ask: async (message, secret, choices, signal) => {
      const muted = new Writable({ write(chunk, _encoding, callback) { if (!secret) process.stdout.write(chunk); callback(); } });
      const rl = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
      const keypress = (_text: string, key: { name?: string }) => { if (key?.name === "escape") stop(); };
      emitKeypressEvents(process.stdin, rl); process.stdin.on("keypress", keypress); rl.on("SIGINT", stop);
      try {
        process.stdout.write(terminalText(message) + "\n");
        choices?.forEach((choice,index)=>process.stdout.write(`${index+1}. ${terminalText(choice.label)}\n`));
        const answer = await rl.question("", { signal: signal ? AbortSignal.any([controller.signal,signal]) : controller.signal });
        if (choices) {
          const choice = choices[Number(answer)-1] ?? choices.find(choice=>choice.id===answer);
          if (!choice) throw new AssistantError("LOGIN_SELECTION", "登录选项无效。请输入选项编号或 ID。");
          return choice.id;
        }
        return answer;
      } finally { process.stdin.off("keypress", keypress); rl.off("SIGINT",stop); rl.close(); muted.end(); process.stdout.write("\n"); }
    },
    dispose: () => { process.off("SIGINT",stop); controller.abort(); },
  };
}

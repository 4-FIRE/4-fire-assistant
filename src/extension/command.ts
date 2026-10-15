import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";
import { showAgents } from "./agents-command.js";

export function registerCommand(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.registerCommand("ffa", {
    description: "工作区：init、status、agents、python /绝对路径",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix)) return null;
      return ["init", "status", "agents", "python"]
        .filter(command => command.startsWith(prefix))
        .map(command => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      confirmations.resume();
      if (command === "init") {
        await ctx.waitForIdle();
        const current = await lifecycle.inspect(ctx.cwd);
        if (current?.status === "ready") { await ctx.reload(); return; }
        const prompt = await readFile(join(resourceRoot, "prompts/initialization-request.md"), "utf8");
        await lifecycle.start(ctx.cwd, (value, continuing) =>
          confirmations.ask(ctx, continuing ? "继续工作区初始化？" : "在此目录创建工作区？", value.root));
        pi.sendUserMessage(prompt.trim());
        return;
      }
      if (command === "status") {
        const current = await lifecycle.inspect(ctx.cwd);
        ctx.ui.notify(JSON.stringify({ state: current ?? "inactive", unknownCalls: lifecycle.active?.execution.unknownCalls() ?? [] }, null, 2), "info"); return;
      }
      if (command === "agents") { await showAgents(pi, lifecycle.get(), ctx, confirmations); return; }
      if (command === "python") {
        const instance = lifecycle.get(), cancel = instance.signal(ctx.signal);
        await instance.research.configure(rest.join(" "),
          (value, signal) => confirmations.ask(ctx, "确认共享 Python 环境", value, signal), cancel);
        return;
      }
      ctx.ui.notify("用法：/ffa init | status | agents | python /绝对路径", "info");
    },
  });
}

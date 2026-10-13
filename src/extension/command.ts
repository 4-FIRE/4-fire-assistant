import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import { requireThat } from "../common/validation.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";
import { showAgents } from "./agents-command.js";

export function registerCommand(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.registerCommand("ffa", {
    description: "工作区：init、update、status、agents、resolve ID 核对依据、python /绝对路径",
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      confirmations.resume();
      if (command === "init") {
        await ctx.waitForIdle();
        const current = await lifecycle.inspect(ctx.cwd);
        if (current?.status === "ready") { await ctx.reload(); return; }
        const prompt = await readFile(join(resourceRoot, "prompts/initialization-request.md"), "utf8");
        await lifecycle.start(ctx.cwd, (value, continuing) =>
          confirmations.ask(ctx, continuing ? "继续工作区初始化？" : "在此目录创建工作区？", value));
        pi.sendUserMessage(prompt.trim());
        return;
      }
      if (command === "update") {
        await ctx.waitForIdle();
        const current = await lifecycle.inspect(ctx.cwd);
        if (current?.status !== "ready") { ctx.ui.notify("请先执行 /ffa init 完成初始化。", "info"); return; }
        const instance = lifecycle.get(); instance.check(true);
        const value = await instance.updates.start(instance.signal(ctx.signal));
        if (value.done) { ctx.ui.notify("工作区已达到目标版本，无需升级。", "info"); return; }
        const prompt = await readFile(join(resourceRoot, "prompts/workspace-update-request.md"), "utf8");
        instance.check(true);
        pi.sendUserMessage(prompt.trim() + "\n\n" + JSON.stringify(value, null, 2));
        return;
      }
      if (command === "status") {
        const current = await lifecycle.inspect(ctx.cwd);
        ctx.ui.notify(JSON.stringify({ state: current ?? "inactive", unresolved: lifecycle.active?.execution.unsettled() ?? [] }, null, 2), "info"); return;
      }
      const instance = lifecycle.get();
      if (command === "agents") { await showAgents(pi, instance, ctx, confirmations); return; }
      if (command === "resolve") {
        await ctx.waitForIdle(); instance.check();
        const id = rest.shift(), note = rest.join(" "); requireThat(id && note, "用法：/ffa resolve ID 核对依据");
        const cancel = instance.signal(ctx.signal);
        await instance.execution.resolve(id, note, value => confirmations.ask(ctx, "确认人工结案（不重发）", value, cancel), cancel);
        ctx.ui.notify("已记录核对结论；不授权重发。", "info"); return;
      }
      if (command === "python") {
        const cancel = instance.signal(ctx.signal);
        await instance.research.configure(rest.join(" "), value => confirmations.ask(ctx, "确认共享 Python 环境", value, cancel), cancel);
        return;
      }
      ctx.ui.notify("用法：/ffa init | update | status | agents | resolve ID 核对依据 | python /绝对路径", "info");
    },
  });
}

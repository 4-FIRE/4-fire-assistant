import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import { mutationTarget } from "../common/files.js";
import { mutationScope } from "../services/workspace/workspace-files.js";
import { agentText } from "../integrations/pi/agent-resources.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";

export function registerEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.on("session_start", async (_event, ctx) => {
    await lifecycle.close();
    try {
      const current = await lifecycle.inspect(ctx.cwd);
      if (current?.status === "ready") {
        await lifecycle.open(ctx.cwd, current);
        ctx.ui.notify("正在准备共享 Python 环境；首次安装可能需要数分钟。", "info");
        try { await lifecycle.get().preparePython(); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(message, "warning"); else console.error(message);
        }
      }
      else if (ctx.hasUI) ctx.ui.notify(current ? "初始化未完成；执行 /ffa init 接续。" : "ffa 未启用；需要时执行 /ffa init。", "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "ffa 启动失败。", "error");
      else throw error;
    }
  });
  pi.on("resources_discover", () => lifecycle.active?.initialization.snapshot().status === "ready" ? { skillPaths: [join(resourceRoot, "skills")] } : {});
  pi.on("before_agent_start", async event => {
    const instance = lifecycle.active;
    if (!instance) return;
    instance.cancelWork();
    const role = instance.initialization.snapshot().status === "ready"
      ? await agentText("coordinator", instance.root) : await readFile(join(resourceRoot, "initialization.md"), "utf8");
    const workspace = await readFile(join(resourceRoot, "prompts/workspace.md"), "utf8");
    instance.check();
    event.systemPromptOptions.sections.ffa_workspace = workspace;
    event.systemPromptOptions.sections.ffa = "ffa 包内资料根目录：" + resourceRoot +
      "\n共享 Python 环境状态：" + JSON.stringify(instance.pythonEnvironment.status) + "\n" + role;
  });
  pi.on("input", () => { lifecycle.active?.cancelWork(); });
  pi.on("agent_end", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_before_switch", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_before_fork", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_before_tree", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_shutdown", event => lifecycle.close(event.reason === "quit"));
  pi.on("tool_call", async (event, ctx) => {
    const instance = lifecycle.active;
    if (["write", "edit"].includes(event.toolName) && "path" in event.input && typeof event.input.path === "string") {
      const path = event.input.path.replace(/^@/, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
      const expanded = /^file:\/\//.test(path) ? fileURLToPath(path)
        : path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
      const target = resolve(ctx.cwd, expanded);
      if (!instance) {
        // Internal state remains protected while workspace tools are inactive.
        if (mutationScope(await realpath(ctx.cwd), await mutationTarget(target)) === "internal" && await lifecycle.inspect(ctx.cwd)) {
          return { block: true, reason: "内部状态必须通过 ffa 专用操作修改。" };
        }
        return;
      }
      const cancel = instance.signal(ctx.signal);
      try {
        await instance.authorizeFile(target, event.input,
          value => confirmations.ask(ctx, "确认修改工作区外文件", value, cancel), cancel);
      } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    return;
  });
}

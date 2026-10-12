import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import { mutationTarget } from "../common/files.js";
import { mutationScope } from "../services/workspace-files.js";
import { roleText } from "../integrations/expert-resources.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";

export function registerEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.on("session_start", async (_event, ctx) => {
    await lifecycle.close();
    try {
      const current = await lifecycle.inspect(ctx.cwd);
      if (current?.status === "ready") await lifecycle.open(ctx.cwd, current);
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
    instance.newRequest();
    const role = instance.initialization.snapshot().status === "ready"
      ? await roleText("coordinator", instance.root) : await readFile(join(resourceRoot, "initialization.md"), "utf8");
    instance.check();
    event.systemPromptOptions.sections.ffa = "ffa 包内资料根目录：" + resourceRoot + "\n" + role;
  });
  pi.on("input", () => { lifecycle.active?.revoke(); });
  pi.on("agent_end", () => { lifecycle.active?.revoke(); });
  pi.on("session_before_switch", () => { lifecycle.active?.revoke(); });
  pi.on("session_before_fork", () => { lifecycle.active?.revoke(); });
  pi.on("session_before_tree", () => { lifecycle.active?.revoke(); });
  pi.on("session_shutdown", () => lifecycle.close());
  pi.on("tool_call", async (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance) return;
    if (instance.providers.blocks(event.toolName)) return { block: true, reason: "此原生 MCP 操作受 ffa 调用约束保护。请通过能力目录和受控入口执行。" };
    if (["write", "edit"].includes(event.toolName) && "path" in event.input && typeof event.input.path === "string") {
      const target = await mutationTarget(resolve(ctx.cwd, event.input.path));
      instance.check();
      const scope = mutationScope(instance.root, target);
      if (scope === "internal") return { block: true, reason: "内部状态必须通过 ffa 专用操作修改。" };
      if (scope === "outside") {
        if (!await confirmations.ask(ctx, "确认修改工作区外文件", { path: target, change: event.input }, instance.signal(ctx.signal))) {
          return { block: true, reason: "用户未确认文件修改。" };
        }
        instance.check();
      }
    }
    return;
  });
}

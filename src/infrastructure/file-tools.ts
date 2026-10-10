import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-durable/tools";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { AssistantError } from "../application/ports.js";
import { resourceRoot } from "./resources.js";
import type { ConfirmAction } from "./workspace-services.js";

async function destination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await destination(dirname(path)), basename(path));
  }
}
/** A tool-path policy, not protection against trusted arbitrary Python. */
export async function fileMutationPolicy(directory: string, path: string): Promise<"ordinary" | "confirm" | "state"> {
  const root = await realpath(directory), lexical = resolve(root, path), target = await destination(lexical);
  const locals = [lexical, target].map(value => relative(root, value));
  if (locals.some(local => /^(config\.json|state\.sqlite(?:-.*)?|instance\.lock(?:-.*)?)$/.test(local) || local.startsWith("memory/"))) return "state";
  const bundled = relative(resourceRoot, target);
  if (locals.some(local => ["AGENTS.md", "BOOTSTRAP.md", "BOOT.md", "SOUL.md"].includes(local) || /^(roles|skills|extensions)\//.test(local)) ||
      !bundled.startsWith("..") || ["SKILL.md", "SOUL.md", "BOOTSTRAP.md", "BOOT.md"].includes(basename(target)) ||
      basename(target) === "AGENTS.md" && !locals.some(local => local.startsWith("sources/"))) return "confirm";
  return "ordinary";
}
export function fileTools(directory: string, confirm: ConfirmAction,
  guard: (api: ToolExecutionApi, ctx: Context) => Promise<unknown>): ToolRegistration[] {
  return [createReadTool(), createWriteTool(), createEditTool()].map(tool => ({
    ...tool,
    replay: tool.name === "read" ? "safe" as const : "unsafe" as const,
    execute: async (args, api, ctx) => {
      await guard(api, ctx);
      const input = args as Record<string, unknown>;
      if (tool.name !== "read") {
        const target = await destination(resolve(directory, input.path as string));
        const kind = await fileMutationPolicy(directory, input.path as string);
        if (kind === "state") throw new AssistantError("STATE_WRITE_DENIED", "程序状态通过专用工具修改；记忆请用 memory_save。");
        if (kind === "confirm" && !await confirm("修改长期角色、技能或行为指引", JSON.stringify({ tool: tool.name, ...input }, null, 2), ctx.abortSignal)) {
          throw new AssistantError("DOCUMENT_CHANGE_DECLINED", "用户未确认修改长期指引。");
        }
        await guard(api, ctx);
        if (await destination(resolve(directory, input.path as string)) !== target || await fileMutationPolicy(directory, input.path as string) !== kind) throw new AssistantError("FILE_TARGET_CHANGED", "目标路径已变化，请重新确认。");
      }
      return (tool as ToolRegistration).execute(args, api, ctx);
    },
  }));
}

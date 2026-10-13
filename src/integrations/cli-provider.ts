import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { isCommandName, requireThat } from "../common/validation.js";
import { canonical, type Params } from "../common/json.js";
import type { Provider, Operation } from "../model/provider.js";
import { environment } from "./provider-environment.js";
import { processEnvironment, runCommand } from "./process.js";

export async function cliExecutable(root: string, provider: Provider, env = processEnvironment(environment(provider))) {
  requireThat(provider.command && isCommandName(provider.command), "CLI 需要 PATH 中可直接执行的命令名。");
  for (const directory of env.PATH.split(delimiter)) {
    const candidate = resolve(root, directory, provider.command);
    try {
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("CLI 命令不可执行或不在 PATH 中：" + provider.command);
}

export async function invokeCli(root: string, provider: Provider, operation: Operation, parameters: Params, preview: Params,
  gate: (native: unknown) => void, signal?: AbortSignal) {
  const env = processEnvironment(environment(provider)), executable = await cliExecutable(root, provider, env);
  gate({ inputSchema: operation.inputSchema, executable });
  return runCommand(executable, preview.argv as string[], operation.stdin ? canonical(parameters) : undefined,
    root, env, signal);
}

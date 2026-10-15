import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { isCommandName, requireThat } from "../../common/validation.js";
import { canonical, type Params } from "../../common/json.js";
import type { Provider, Operation } from "../../model/provider.js";
import { environment } from "./provider-environment.js";
import { processEnvironment, runCommand } from "../process.js";
import type { ProviderCallStrategy } from "./provider-call-strategy.js";

async function cliExecutable(root: string, provider: Provider, env: ReturnType<typeof processEnvironment>) {
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

export class CliProvider implements ProviderCallStrategy {
  constructor(private readonly root: string) {}

  environment(provider: Provider) {
    return processEnvironment(environment(provider));
  }
  async prepare(provider: Provider) {
    await cliExecutable(this.root, provider, this.environment(provider));
  }
  preview(provider: Provider, operation: Operation, parameters: Params) {
    requireThat(provider.command, "CLI 需要命令名。");
    requireThat(operation.argv, "CLI 操作没有参数绑定。");
    const argv = operation.argv.map(token => {
      if (typeof token === "string") return token;
      if ("json" in token) return canonical(parameters);
      const value = parameters[token.parameter];
      requireThat(["string", "boolean", "number"].includes(typeof value), "单个 argv 参数必须是标量。");
      return String(value);
    });
    requireThat(argv.every(value => !value.includes("\0")), "argv 不得包含 NUL。");
    return { provider: provider.id, command: provider.command, argv, stdin: operation.stdin ? canonical(parameters) : null };
  }
  async definition(provider: Provider, operation: Operation) {
    const executable = await cliExecutable(this.root, provider, this.environment(provider));
    return { inputSchema: operation.inputSchema, executable };
  }
  async invoke(provider: Provider, operation: Operation, parameters: Params, gate: (native: Params) => void,
    signal?: AbortSignal) {
    const preview = this.preview(provider, operation, parameters);
    const env = this.environment(provider);
    const executable = await cliExecutable(this.root, provider, env);
    gate({ inputSchema: operation.inputSchema, executable });
    return runCommand(executable, preview.argv, preview.stdin ?? undefined, this.root, env, signal);
  }
}

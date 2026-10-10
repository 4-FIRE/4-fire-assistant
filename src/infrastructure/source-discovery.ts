import { spawn } from "node:child_process";
import { access, realpath, stat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { AssistantError } from "../application/ports.js";
import { McpConnection } from "./integrations/mcp-connection.js";
import { parseSourceConnection } from "./integrations/connection-config.js";

export async function locateCli(command: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(command)) throw new AssistantError("CLI_NAME_INVALID", "请提供单独的命令名。");
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = resolve(directory, command);
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); } catch { /* Try next PATH entry. */ }
  }
  throw new AssistantError("CLI_MISSING", "PATH 中没有这个命令；请阅读安装说明。");
}
export async function discoverSource(input: unknown, args: string[], cwd: string, signal?: AbortSignal): Promise<unknown> {
  const connection = parseSourceConnection(input);
  if (connection.transport !== "cli") {
    const client = await McpConnection.connect(connection, { cwd, inheritEnv: false, ...(signal ? { signal } : {}) });
    try { return { tools: client.catalog(), unavailableSchemas: client.unavailableSchemas }; } finally { await client.close(); }
  }
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const [key, ref] of Object.entries(connection.env ?? {})) {
    if (process.env[ref] === undefined) throw new AssistantError("CREDENTIAL_MISSING", "来源所需环境变量未设置。");
    env[key] = process.env[ref]!;
  }
  return run(connection.command, args, cwd, env, signal);
}
export async function installPackage(command: string, args: string[], directory: string, signal?: AbortSignal) {
  const name = basename(command);
  const allowed = ["npm", "npm-cli.js"].includes(name) && args[0] === "install" ||
    /^pip(?:3(?:\.\d+)?)?$/.test(name) && args[0] === "install" ||
    name === "uv" && ["tool", "pip"].includes(args[0] ?? "") && args[1] === "install" ||
    /^python(?:3(?:\.\d+)?)?$/.test(name) && args.slice(0, 3).join(" ") === "-m pip install";
  if (!isAbsolute(command) || !allowed) throw new AssistantError("INSTALL_COMMAND_INVALID", "只接受可信说明中的包安装器绝对路径和安装参数，不接受 shell 或 sudo。");
  const cwd = join(directory, "packages"), home = join(cwd, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return run(command, args, cwd, { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", XDG_CACHE_HOME: join(home, "cache") }, signal);
}
function run(command: string, args: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  if (command.includes("\0") || args.some(arg => arg.includes("\0"))) throw new AssistantError("INVALID_ARGUMENTS", "参数包含无效字符。");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
    const fail = () => { failed = true; kill(); };
    const timer = setTimeout(fail, 120_000); signal?.addEventListener("abort", fail, { once: true });
    const collect = (data: Buffer) => { bytes += data.length; if (bytes > 1024 * 1024) fail(); else chunks.push(data); };
    child.stdout.on("data", collect); child.stderr.on("data", collect); child.on("error", fail);
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", fail); kill();
      if (failed || signal?.aborted) reject(new AssistantError("PROCESS_INTERRUPTED", "进程中断；可能已经产生文件或副作用，先核对，不自动重装。"));
      else resolve({ exitCode: code, output: Buffer.concat(chunks).toString("utf8"), success: code === 0 });
    });
    if (signal?.aborted) fail();
  });
}

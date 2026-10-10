import { spawn } from "node:child_process";
import { isAbsolute, resolve, delimiter, basename, dirname, join } from "node:path";
import { access, realpath, stat, lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import type { SetupSource } from "../domain/workspace.js";
import type { InitializationDiscovery, McpInstallation } from "../application/initialization.js";
import { AssistantError } from "../application/ports.js";
import { McpConnection } from "./integrations/mcp.js";
import { parseConfig } from "./config.js";
import type { SourceConnection } from "./tool-contracts.js";

const limit = 128 * 1024;
function connection(source: SetupSource): SourceConnection {
  const value = source.connection ?? (source.kind === "cli" ? { transport: "cli", command: source.location } : { transport: "http", url: source.location });
  let checked: SourceConnection;
  try { checked = parseConfig({ version: 1, sources: { discovery: value } }).sources!.discovery!; }
  catch { throw new AssistantError("SETUP_SOURCE_INCOMPLETE", "来源连接材料不完整；请提供有效地址或单独的 CLI 绝对路径。"); }
  if ((checked.transport === "cli") !== (source.kind === "cli")) throw new AssistantError("SETUP_SOURCE_INCOMPLETE", "来源类型与连接材料不一致。");
  return checked;
}
function entry(source: SetupSource): string {
  const config = connection(source);
  if (source.kind === "mcp") return `MCP 连接与工具清单：${JSON.stringify(config)}`;
  if (config.transport !== "cli" || !isAbsolute(config.command) || config.command.includes("\0")) throw new AssistantError("SETUP_SOURCE_INCOMPLETE", "CLI 发现需要单独的可执行文件绝对路径，不接受 shell 命令行。");
  return JSON.stringify({ argv: [config.command, ...(source.discoveryArgs ?? ["--help"])], envRefs: config.env ?? {} });
}
function installationEntry(request: McpInstallation, cwd: string): string {
  const command = basename(request.command), args = request.args;
  const npm = ["npm", "npm-cli.js"].includes(command) && args[0] === "install";
  const pip = /^pip(?:3(?:\.\d+)?)?$/.test(command) && args[0] === "install";
  const uv = command === "uv" && ["tool", "pip"].includes(args[0] ?? "") && args[1] === "install";
  const python = /^python(?:3(?:\.\d+)?)?$/.test(command) && args.slice(0, 3).join(" ") === "-m pip install";
  if (!request.name.trim() || !isAbsolute(request.command) || request.command.includes("\0") || !args.length || args.length > 256 ||
      args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192) || !(npm || pip || uv || python)) {
    throw new AssistantError("MCP_INSTALL_INVALID", "请依据安装文档提供 npm install、pip install、uv tool/pip install 或 python -m pip install 的绝对入口和原生参数；不接受 shell、sudo、脚本或其他操作。");
  }
  return JSON.stringify({ argv: [request.command, ...args], cwd: join(cwd, ".ffa", "mcp"), environment: "独立 HOME 与缓存，不继承凭据。包安装器及安装脚本仍需可信。" });
}
function run(command: string, args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number, allowEmpty = false): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, failed = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
    const fail = () => { failed = true; kill(); };
    const timer = setTimeout(fail, timeoutMs);
    signal.addEventListener("abort", fail, { once: true });
    const collect = (chunk: Buffer) => { size += chunk.length; if (size > limit) fail(); else chunks.push(chunk); };
    child.stdout.on("data", collect); child.stderr.on("data", collect); child.on("error", fail);
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", fail); kill();
      const text = Buffer.concat(chunks).toString("utf8");
      if (failed || code !== 0 || signal.aborted || !allowEmpty && !text.trim()) reject(new AssistantError(allowEmpty ? "MCP_INSTALL_FAILED" : "SETUP_DISCOVERY_FAILED", "外部进程失败、取消、返回无效内容或超出限制；不能宣称操作成功，安装可能已产生部分文件，请先核对。"));
      else resolve(text);
    });
    if (signal.aborted) fail();
  });
}

/** Only explicitly confirmed metadata, document reads and package installations. */
export function initializationDiscovery(cwd: string): InitializationDiscovery {
  return {
    entry,
    installationEntry: request => installationEntry(request, cwd),
    async locateCli(command, signal) {
      signal.throwIfAborted();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(command)) throw new AssistantError("SETUP_SOURCE_INCOMPLETE", "CLI 需要单独的命令名，不接受 shell 命令行。");
      for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        signal.throwIfAborted();
        const path = resolve(cwd, directory, command);
        try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); }
        catch { /* Try the next PATH entry without executing anything. */ }
      }
      throw new AssistantError("SETUP_CLI_NOT_FOUND", `未在 PATH 中找到 ${command}。请阅读安装说明或提供绝对路径；不能视为已安装。`);
    },
    async readDocument(path, signal, offset = 0) {
      signal.throwIfAborted();
      if (!isAbsolute(path) || !Number.isSafeInteger(offset) || offset < 0) throw new AssistantError("SETUP_DOCUMENT_INVALID", "资料需要单独的绝对路径和非负读取位置。");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 1024 * 1024) throw new AssistantError("SETUP_DOCUMENT_LIMIT", "只读取不超过 1 MiB 的普通资料文件。");
        const text = await file.readFile("utf8"); signal.throwIfAborted();
        return { text: text.slice(offset, offset + 16000), nextOffset: offset + 16000 < text.length ? offset + 16000 : null };
      } finally { await file.close(); }
    },
    async installMcp(request, signal) {
      installationEntry(request, cwd); signal.throwIfAborted();
      const directory = join(cwd, ".ffa", "mcp");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new AssistantError("MCP_INSTALL_INVALID", "安装目录不能是符号链接。");
      const home = join(directory, "home");
      await mkdir(home, { recursive: true, mode: 0o700 });
      if ((await lstat(home)).isSymbolicLink()) throw new AssistantError("MCP_INSTALL_INVALID", "安装 HOME 不能是符号链接。");
      return run(request.command, request.args, directory, { PATH: dirname(process.execPath) + ":/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, XDG_CACHE_HOME: join(home, "cache") }, signal, 120_000, true);
    },
    async inspect(source, signal) {
      entry(source);
      const config = connection(source); signal.throwIfAborted();
      if (config.transport !== "cli") {
        const connection = await McpConnection.connect({ ...config, timeoutMs: 10_000 }, { cwd, signal, inheritEnv: false });
        try {
          const text = JSON.stringify({ tools: connection.catalog(), unavailableSchemas: connection.unavailableSchemas }, null, 2);
          if (Buffer.byteLength(text) > limit) throw new AssistantError("SETUP_DISCOVERY_LIMIT", "工具清单过大；请提供所需操作的说明。");
          return text;
        } finally { await connection.close(); }
      }
      const environment: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
      for (const [key, ref] of Object.entries(config.env ?? {})) {
        if (process.env[ref] === undefined) throw new AssistantError("CLI_ENV_MISSING", "CLI 发现所需环境引用未设置。");
        environment[key] = process.env[ref]!;
      }
      return run(config.command, source.discoveryArgs ?? ["--help"], cwd, environment, signal, 10_000);
    },
  };
}

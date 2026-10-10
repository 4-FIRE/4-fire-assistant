import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { access, constants, lstat, mkdir, readFile, realpath, readdir, rename, rm, open, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantError } from "../application/ports.js";
import { canonical, object, type Json, type Parameters } from "../domain/shared.js";

const exec = promisify(execFile);
const pythonRoot = fileURLToPath(new URL("../../python/", import.meta.url));
const backendVersion = "0.1.0";
interface RuntimeRecord { version: string; python: string; base: string; pythonVersion: string }
export interface ResearchSettings { runtimeDirectory: string }
export interface ResearchInput { project: string; request: Parameters; strategy?: string; evidence: Json[] }

function fail(message: string): never { throw new AssistantError("RESEARCH_UNAVAILABLE", message); }
async function runtimeRecord(directory: string): Promise<RuntimeRecord> {
  const value: unknown = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  if (!object(value) || value.version !== backendVersion || typeof value.python !== "string" || !isAbsolute(value.python) ||
      typeof value.base !== "string" || !isAbsolute(value.base) || value.base === "/" ||
      typeof value.pythonVersion !== "string") fail("计算环境版本不符；运行 ffa --setup-compute。");
  return value as unknown as RuntimeRecord;
}

/** Explicit host command only. Generated strategies run only through the research process. */
export async function installResearchRuntime(directory: string, python = "python3"): Promise<void> {
  if (process.platform !== "linux") fail("计算仅支持 Linux。");
  try { await runtimeRecord(directory); return; } catch { /* Install a fresh fixed environment. */ }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = directory + "." + randomUUID();
  try {
    await exec(python, ["-I", "-m", "venv", temporary], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const executable = join(temporary, "bin", "python");
    await exec(executable, ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
      "-r", join(pythonRoot, "requirements.lock")], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    const details = JSON.parse((await exec(executable, ["-I", "-c", "import sys,json;print(json.dumps({'base':sys.base_prefix,'version':sys.version}))"])).stdout);
    if (Number(details.version.split(".")[0]) !== 3 || Number(details.version.split(".")[1]) < 11) fail("需要 Python 3.11 或更新版本。");
    await writeFile(join(temporary, "runtime.json"), JSON.stringify({ version: backendVersion, python: join(directory, "bin", "python"),
      base: details.base, pythonVersion: details.version }) + "\n", { mode: 0o600 });
    // Never replace a runtime while another process might be using it.
    await rename(temporary, directory);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function controlledDirectory(root: string, parts: string[]): Promise<string> {
  let current = await realpath(root);
  for (const part of parts) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(part) || part === "..") fail("研究路径标识无效。");
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("研究路径必须为工作区内的普通目录。");
  }
  return current;
}

export class Research {
  constructor(private readonly workspace: string, private readonly settings: ResearchSettings) {}
  async status(): Promise<{ available: boolean; mode?: string; reason?: string }> {
    try { await this.check(); return { available: true, mode: "python" }; }
    catch (error) { return { available: false, reason: error instanceof AssistantError ? error.message : "计算环境不完整；运行 ffa --setup-compute。" }; }
  }
  private async check(): Promise<RuntimeRecord> {
    if (process.platform !== "linux") fail("计算仅支持 Linux。");
    const runtime = await runtimeRecord(this.settings.runtimeDirectory);
    await access(runtime.python, constants.X_OK);
    return runtime;
  }
  async list(project?: string): Promise<Json> {
    const base = await this.existing(project ? ["projects", project] : ["projects"]);
    if (!base) return [];
    if (!project) return (await readdir(base, { withFileTypes: true })).filter(e => e.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(e.name)).map(e => e.name).sort().slice(0, 200);
    const path = await this.existing(["projects", project, "runs"]);
    return { runs: path ? (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort().slice(0, 200) : [] };
  }
  private async existing(parts: string[]): Promise<string | undefined> {
    let path = await realpath(this.workspace);
    for (const part of parts) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(part) || part === "..") fail("研究路径标识无效。");
      path = join(path, part);
      try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("研究路径不是普通目录。"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }
    return path;
  }
  async read(project: string, id: string, file = "result.json", offset = 0): Promise<Json> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id) || id === ".." || !Number.isSafeInteger(offset) || offset < 0 ||
        !["manifest.json", "request.json", "result.json"].includes(file)) fail("研究引用或读取位置无效。");
    const directory = await this.existing(["projects", project, "runs", id]);
    if (!directory) fail("研究记录不存在。");
    const path = join(directory, file);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024) fail("研究记录不是有效的有界文件。");
      const text = await handle.readFile("utf8");
      return { text: text.slice(offset, offset + 16000), nextOffset: offset + 16000 < text.length ? offset + 16000 : null };
    } finally { await handle.close(); }
  }
  async run(input: ResearchInput, signal?: AbortSignal): Promise<Json> {
    const exact = structuredClone(input);
    canonical(exact.request);
    if (Buffer.byteLength(JSON.stringify(exact)) > 8 * 1024 * 1024) fail("实验输入超过 8 MiB。");
    if (!["indicators", "backtest"].includes(String(exact.request.operation)) || exact.request.version !== 1) fail("不支持的计算请求。");
    if (exact.request.operation === "backtest" && !exact.strategy?.trim()) fail("回测需要策略源码。");
    const runtime = await this.check();
    signal?.throwIfAborted();
    const runId = randomUUID();
    const directory = await controlledDirectory(this.workspace, ["projects", exact.project, "runs", runId]);
    const inputs = await controlledDirectory(directory, ["inputs"]);
    const logs = await controlledDirectory(directory, ["logs"]);
    const request = JSON.stringify(exact.request);
    await writeFile(join(inputs, "request.json"), request, { flag: "wx", mode: 0o400 });
    if (exact.strategy) await writeFile(join(inputs, "strategy.py"), exact.strategy, { flag: "wx", mode: 0o400 });
    await writeFile(join(inputs, "evidence.json"), JSON.stringify(exact.evidence), { flag: "wx", mode: 0o400 });
    await writeFile(join(directory, "request.json"), request, { flag: "wx", mode: 0o400 });
    const manifest: Parameters = { runId, startedAt: new Date().toISOString(), state: "starting", backend: backendVersion,
      runtime: { ...runtime }, mode: "python", isolation: "none",
      limits: { timeoutMs: 120000, outputBytes: 16777216 } };
    const manifestPath = join(directory, "manifest.json");
    const persist = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await persist();
    try {
      const raw = await this.spawn(runtime.python, ["-B", "-c",
          "import sys,runpy;sys.path.insert(0," + JSON.stringify(join(pythonRoot, "src")) + ");sys.argv=['ffa_compute',sys.argv[1]];runpy.run_module('ffa_compute',run_name='__main__')",
          join(inputs, "request.json")], directory, signal);
      await writeFile(join(logs, "stderr.txt"), raw.stderr, { mode: 0o600 });
      await writeFile(join(logs, "stdout.txt"), raw.stdout, { mode: 0o600 });
      manifest.exitCode = raw.code;
      if (raw.failure || raw.code !== 0) throw new AssistantError("RESEARCH_FAILED", raw.failure ?? "计算失败；原始日志已保留。");
      const result: unknown = JSON.parse(raw.stdout);
      if (!object(result) || result.version !== 1 || result.backend !== backendVersion || !["ok", "error"].includes(String(result.status)) ||
          result.status === "ok" && (!object(result.series) || exact.request.operation === "backtest" &&
            (!object(result.metrics) || !Array.isArray(result.trades) || !object(result.rejections)))) fail("计算结果结构无效。");
      manifest.state = result.status === "ok" ? "completed" : "failed";
      await writeFile(join(directory, "result.json"), JSON.stringify(result), { mode: 0o400 });
      return { runId, path: relative(this.workspace, directory), result: result as Json };
    } catch (error) {
      manifest.state = "failed";
      manifest.error = error instanceof AssistantError ? error.message : "计算、协议或存储检查失败。";
      throw new AssistantError("RESEARCH_FAILED", `实验 ${runId} 失败：${manifest.error}`);
    } finally {
      manifest.finishedAt = new Date().toISOString();
      await persist();
    }
  }
  private spawn(python: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null; failure?: string }> {
    signal?.throwIfAborted();
    return new Promise(resolve => {
      const child = spawn(python, ["-I", ...args], { cwd, env: { LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, failure: string | undefined;
      const stop = (reason: string) => {
        failure ??= reason;
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      };
      const abort = () => stop("用户取消；实验结果无效。");
      const timer = setTimeout(() => stop("计算超过 120 秒。"), 120_000);
      const capture = (output: Buffer[]) => (data: Buffer) => {
        bytes += data.length;
        if (bytes > 16 * 1024 * 1024) stop("计算输出超过 16 MiB。"); else output.push(data);
      };
      child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
      child.on("error", () => stop("无法启动计算。"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, ...(failure ? { failure } : {}) });
      });
    });
  }
}

import { spawn, execFile } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { access, constants, lstat, mkdir, readFile, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantError } from "../application/ports.js";
import { canonical, object, type Json } from "../domain/shared.js";

const exec = promisify(execFile);
const pythonRoot = fileURLToPath(new URL("../../python/", import.meta.url));
const backendVersion = "0.2.0";
interface RuntimeRecord { version: string; python: string; pythonVersion: string }
export interface ResearchSettings { runtimeDirectory: string }
export interface ResearchInput { project: string; code: string; inputs: Json; evidence: Json[] }
function fail(message: string): never { throw new AssistantError("RESEARCH_UNAVAILABLE", message); }
function identifier(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value) || value === "..") fail("研究标识无效。");
}
async function runtimeRecord(directory: string): Promise<RuntimeRecord> {
  const value: unknown = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  if (!object(value) || value.version !== backendVersion || typeof value.python !== "string" || !isAbsolute(value.python) ||
      typeof value.pythonVersion !== "string") fail("共享计算环境版本不符；运行 ffa --setup-compute。");
  return value as unknown as RuntimeRecord;
}
export async function installResearchRuntime(directory: string, python = "python3"): Promise<void> {
  if (process.platform !== "linux") fail("计算仅支持 Linux。");
  try {
    const runtime = await runtimeRecord(directory);
    await access(runtime.python, constants.X_OK); return;
  } catch { /* Preserve an existing but invalid environment. */ }
  try { await lstat(directory); fail("共享环境目录已存在但不可用；请先移走该目录，再重新安装。"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = directory + "." + randomUUID();
  try {
    await exec(python, ["-I", "-m", "venv", temporary], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const executable = join(temporary, "bin", "python");
    await exec(executable, ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
      "-r", join(pythonRoot, "requirements.lock")], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    const version = (await exec(executable, ["-I", "-c", "import sys;print(sys.version)"])).stdout.trim();
    if (Number(version.split(".")[0]) !== 3 || Number(version.split(".")[1]) < 11) fail("需要 Python 3.11 或更新版本。");
    await writeFile(join(temporary, "runtime.json"), JSON.stringify({ version: backendVersion, python: join(directory, "bin", "python"), pythonVersion: version }) + "\n", { mode: 0o600 });
    await rename(temporary, directory);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Ordinary Python. Records experiments without prescribing a research protocol. */
export class Research {
  private readonly activeRuns = new Set<string>();
  constructor(private readonly workspace: string, private readonly settings: ResearchSettings) {}
  async status(): Promise<{ available: boolean; mode?: string; reason?: string }> {
    try { await this.check(); return { available: true, mode: "python" }; }
    catch (error) { return { available: false, reason: error instanceof AssistantError ? error.message : "共享环境不可用；运行 ffa --setup-compute。" }; }
  }
  private async check(): Promise<RuntimeRecord> {
    if (process.platform !== "linux") fail("计算仅支持 Linux。");
    const runtime = await runtimeRecord(this.settings.runtimeDirectory); await access(runtime.python, constants.X_OK); return runtime;
  }
  async list(project?: string): Promise<Json> {
    if (project) identifier(project);
    const directory = join(this.workspace, "projects", ...(project ? [project, "runs"] : []));
    try {
      const entries = (await readdir(directory, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
      if (!project) return entries;
      const runs = [];
      for (const id of entries) {
        try {
          const manifest: unknown = JSON.parse(await readFile(join(directory, id, "manifest.json"), "utf8"));
          if (!object(manifest)) throw new Error("Invalid experiment record");
          const interrupted = ["starting", "running"].includes(String(manifest.state)) && !this.activeRuns.has(id);
          runs.push({ ...manifest, id, ...(interrupted ? { state: "interrupted", recordedState: String(manifest.state) } : {}) });
        } catch { runs.push({ id, state: "unreadable" }); }
      }
      return { runs };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return project ? { runs: [] } : []; throw error; }
  }
  async run(input: ResearchInput, signal?: AbortSignal): Promise<Json> {
    const exact = structuredClone(input); identifier(exact.project); canonical(exact.inputs);
    if (!exact.code.trim() || Buffer.byteLength(JSON.stringify(exact)) > 8 * 1024 * 1024) fail("需要 Python 源码，实验输入上限为 8 MiB。");
    const runtime = await this.check(); signal?.throwIfAborted();
    const runId = randomUUID(), root = await realpath(this.workspace);
    let directory = root;
    for (const part of ["projects", exact.project, "runs", runId]) {
      directory = join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) fail("研究路径必须为普通目录。");
    }
    await writeFile(join(directory, "main.py"), exact.code, { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "inputs.json"), JSON.stringify(exact.inputs), { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "evidence.json"), JSON.stringify(exact.evidence), { mode: 0o600, flag: "wx" });
    const manifest: Record<string, Json> = { runId, startedAt: new Date().toISOString(), state: "starting", mode: "python", isolation: "none",
      runtime: { ...runtime }, timeoutMs: 120000, outputBytes: 16777216 };
    const persist = async () => {
      const temporary = join(directory, "manifest.tmp");
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, join(directory, "manifest.json"));
    };
    this.activeRuns.add(runId);
    try {
      await persist();
      // Stop the direct Python process if its host dies; this is lifecycle control, not isolation.
      const bootstrap = `import os,signal,ctypes,sys,runpy\nctypes.CDLL(None).prctl(1,signal.SIGKILL)\nif os.getppid()!=${process.pid}: sys.exit(1)\nsys.path.insert(0,${JSON.stringify(join(pythonRoot, "src"))})\nsys.path.insert(0,os.getcwd())\nrunpy.run_path('main.py',run_name='__main__')`;
      const result = await this.spawn(runtime.python, bootstrap, directory, signal, async pid => {
        manifest.pid = pid; manifest.state = "running"; await persist();
      });
      manifest.exitCode = result.code;
      manifest.state = result.failure ? signal?.aborted ? "cancelled" : "failed" : result.code === 0 ? "completed" : "failed";
      if (result.failure) manifest.error = result.failure;
      return { runId, path: relative(root, directory), state: manifest.state, exitCode: result.code,
        stdout: result.stdout.slice(0, 16000), stderr: result.stderr.slice(0, 16000),
        truncated: result.stdout.length > 16000 || result.stderr.length > 16000 };
    } catch (error) {
      manifest.state = signal?.aborted ? "cancelled" : "failed";
      manifest.error = error instanceof AssistantError ? error.message : "运行或记录保存失败。";
      throw error;
    } finally {
      try { manifest.finishedAt = new Date().toISOString(); await persist(); }
      finally { this.activeRuns.delete(runId); }
    }
  }
  private spawn(python: string, bootstrap: string, cwd: string, signal: AbortSignal | undefined, started: (pid: number) => Promise<void>): Promise<{ stdout: string; stderr: string; code: number | null; failure?: string }> {
    signal?.throwIfAborted();
    const out = openSync(join(cwd, "stdout.txt"), "wx", 0o600);
    let err: number;
    try { err = openSync(join(cwd, "stderr.txt"), "wx", 0o600); }
    catch (error) { closeSync(out); throw error; }
    return new Promise(resolve => {
      const child = spawn(python, ["-I", "-B", "-u", "-c", bootstrap], { cwd, env: { LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, failure: string | undefined;
      const stop = (reason: string) => { failure ??= reason; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
      const recorded = child.pid ? started(child.pid).catch(() => stop("无法保存计算进程身份。")) : Promise.resolve();
      const abort = () => stop("用户取消或运行时关闭；未完成计算不能视为成功。");
      const timer = setTimeout(() => stop("计算超过 120 秒。"), 120_000);
      const capture = (output: Buffer[], file: number) => (data: Buffer) => {
        bytes += data.length;
        if (bytes > 16 * 1024 * 1024) { stop("计算输出超过 16 MiB。"); return; }
        output.push(data);
        try { writeSync(file, data); } catch { stop("无法保存运行日志。"); }
      };
      child.stdout.on("data", capture(stdout, out)); child.stderr.on("data", capture(stderr, err));
      child.on("error", () => stop("无法启动 Python。"));
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      child.once("close", async code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); await recorded;
        closeSync(out); closeSync(err);
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, ...(failure ? { failure } : {}) });
      });
    });
  }
}

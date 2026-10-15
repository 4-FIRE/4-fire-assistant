import { mkdir, lstat, realpath, writeFile, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "../../integrations/process.js";
import { atomicFile } from "../../common/files.js";
import { requireThat } from "../../common/validation.js";
import type { Json } from "../../common/json.js";
import type { SettingsFile } from "../../storage/settings-file.js";
import { resourceRoot } from "../../common/paths.js";

export function ownerParts(owner?: string) {
  if (!owner) return ["scratch"];
  const parts = owner.split("/");
  requireThat(parts.length >= 2 && parts.length <= 12 && ["projects", "areas"].includes(parts[0]!) &&
    parts.every(part => part && !part.startsWith(".") && part !== "runs" && !/[\\\x00-\x1f:]/.test(part)), "owner 必须是 projects/名称 或 areas/名称。");
  return parts;
}
export async function runPython(root: string, python: string, input: { code: string; inputs: Json; owner?: string }, signal?: AbortSignal) {
  requireThat(input.code.trim() && Buffer.byteLength(JSON.stringify(input)) <= 8 * 1024 * 1024, "源码不能为空，输入上限为 8 MiB。");
  signal?.throwIfAborted();
  const id = randomUUID(), base = await realpath(root);
  let directory = base;
  for (const part of [...ownerParts(input.owner), "runs", id]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory); requireThat(info.isDirectory() && !info.isSymbolicLink(), "计算目录不能是符号链接。");
  }
  await writeFile(join(directory, "main.py"), input.code, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "inputs.json"), JSON.stringify(input.inputs), { flag: "wx", mode: 0o600 });
  const manifest: Record<string, unknown> = { id, state: "running", startedAt: new Date().toISOString(), python, isolation: "none" };
  const persist = () => atomicFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await persist();
  const library = join(resourceRoot, "../python/src/");
  const bootstrap = `import os,sys,runpy,ctypes,signal\nctypes.CDLL(None).prctl(1,signal.SIGKILL)\nif os.getppid()!=${process.pid}: sys.exit(1)\nsys.path.insert(0,${JSON.stringify(library)})\nsys.path.insert(0,os.getcwd())\nrunpy.run_path('main.py',run_name='__main__')`;
  try {
    const observation = await runCommand(python, ["-I", "-B", "-u", "-c", bootstrap], undefined, directory, {}, signal);
    await writeFile(join(directory, "output.json"), JSON.stringify(observation.data, null, 2), { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "process.json"), JSON.stringify(observation.raw ?? null, null, 2), { mode: 0o600, flag: "wx" });
    manifest.state = signal?.aborted ? "cancelled" : observation.success ? "completed" : "failed";
    return { id, path: relative(base, directory), state: manifest.state, output: observation.data };
  } catch (error) { manifest.state = signal?.aborted ? "cancelled" : "failed"; throw error; }
  finally { manifest.finishedAt = new Date().toISOString(); await persist(); }
}

export class ResearchService {
  readonly #shutdown = new AbortController();
  readonly #active = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  constructor(private readonly root: string, private readonly settings: SettingsFile) {}
  private async track<T>(signal: AbortSignal | undefined, work: (cancel: AbortSignal) => Promise<T>) {
    const cancel = signal ? AbortSignal.any([this.#shutdown.signal, signal]) : this.#shutdown.signal;
    cancel.throwIfAborted();
    const pending = work(cancel);
    this.#active.add(pending);
    try { return await pending; }
    finally { this.#active.delete(pending); }
  }
  run(input: { code: string; inputs: Json; owner?: string }, signal?: AbortSignal) {
    return this.track(signal, async cancel => {
      const python = this.settings.read().python ?? "/usr/bin/python3";
      try { await access(python, constants.X_OK); requireThat((await stat(python)).isFile(), "不是可执行文件。"); }
      catch (error) { throw new Error("Python 解释器不可用，请检查本机路径：" + python, { cause: error }); }
      return runPython(this.root, python, input, cancel);
    });
  }
  configure(python: string, confirm: (value: unknown, signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal) {
    return this.track(signal, async cancel => {
      requireThat(python.startsWith("/"), "需要 Python 可执行文件的绝对路径。");
      requireThat(await confirm({ path: python }, cancel), "用户未确认。");
      cancel.throwIfAborted(); await access(python, constants.X_OK);
      requireThat((await stat(python)).isFile(), "Python 路径必须是可执行文件。");
      cancel.throwIfAborted();
      this.settings.save({ python });
    });
  }
  close(): Promise<void> {
    this.#shutdown.abort();
    return this.#closing ??= Promise.allSettled([...this.#active]).then(() => undefined);
  }
}

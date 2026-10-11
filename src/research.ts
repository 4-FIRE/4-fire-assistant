import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCommand } from "./sources.js";
import { atomicFile } from "./workspace.js";
import { requireThat, type Json } from "./values.js";

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
  const library = fileURLToPath(new URL("../python/src/", import.meta.url));
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

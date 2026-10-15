import { open, realpath, rename, unlink, link } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { requireThat } from "./validation.js";

export async function atomicFile(path: string, content: string, exclusive = false) {
  const temp = path + "." + randomUUID();
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function mutationTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path); requireThat(parent !== path, "无法定位目标路径。");
    return join(await mutationTarget(parent), basename(path));
  }
}
export async function safePath(root: string, path: string): Promise<string> {
  requireThat(!isAbsolute(path) && path.split(/[\\/]/).every(p => p && p !== "." && p !== ".."), "需要工作区内的相对路径。");
  const base = await realpath(root), resolved = await realpath(join(root, path));
  const rel = relative(base, resolved);
  requireThat(rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "路径超出工作区。");
  return resolved;
}

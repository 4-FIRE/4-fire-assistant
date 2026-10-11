import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { object, requireThat } from "./values.js";

export interface WorkspaceState { format: "ffa-pi/1"; status: "pending" | "ready"; market?: string }
export const directories = ["areas", "projects", "knowledge", "sources", "scratch"];
export async function state(root: string): Promise<WorkspaceState | undefined> {
  try {
    const dir = await lstat(join(root, ".ffa"));
    requireThat(dir.isDirectory() && !dir.isSymbolicLink(), ".ffa 必须是普通目录。");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const path = join(root, ".ffa", "workspace.json");
  let value: unknown;
  try {
    requireThat((await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink(), "工作区状态必须是普通文件。");
    value = JSON.parse(await readFile(path, "utf8"));
  } catch { throw new Error("已有 .ffa 状态不可读取。不迁移、不覆盖；请使用新的独立工作区。"); }
  requireThat(object(value) && value.format === "ffa-pi/1" && ["pending", "ready"].includes(String(value.status)), "不支持此工作区格式；不迁移或覆盖旧状态。");
  requireThat(value.status !== "ready" || typeof value.market === "string" && value.market.trim(), "就绪状态缺少市场。");
  return value as unknown as WorkspaceState;
}
export async function atomicFile(path: string, content: string) {
  const temp = path + "." + randomUUID();
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function begin(root: string): Promise<WorkspaceState> {
  const current = await state(root);
  if (current) return current;
  await mkdir(join(root, ".ffa"), { mode: 0o700 }); // Exclusive creation; never adopt a race winner.
  const initial: WorkspaceState = { format: "ffa-pi/1", status: "pending" };
  await atomicFile(join(root, ".ffa", "workspace.json"), JSON.stringify(initial) + "\n");
  return initial;
}
export async function prepareDirectories(root: string) {
  for (const part of directories) {
    const path = join(root, part);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    requireThat((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(), "投资目录不能使用符号链接：" + path);
  }
}
export async function documentsReady(root: string, sources: string[]) {
  for (const path of ["AGENTS.md", "sources/AGENTS.md", ...sources.map(id => "sources/" + id + "/GUIDE.md")]) {
    const full = await safePath(root, path);
    requireThat((await readFile(full, "utf8")).trim(), "请补齐资料：" + path);
  }
}
export async function finish(root: string, market: string) {
  requireThat(market.trim().length > 0 && market.length <= 256, "需要有效的目标市场。");
  requireThat((await state(root))?.status === "pending", "工作区不处于初始化状态。");
  await atomicFile(join(root, ".ffa", "workspace.json"), JSON.stringify({ format: "ffa-pi/1", status: "ready", market }) + "\n");
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

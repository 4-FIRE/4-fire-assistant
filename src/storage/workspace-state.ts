import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { atomicFile } from "../common/files.js";
import { WorkspaceState } from "../model/workspace.js";

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
  return new WorkspaceState(value as unknown as WorkspaceState);
}
export async function begin(root: string): Promise<WorkspaceState> {
  const current = await state(root);
  if (current) return current;
  await mkdir(join(root, ".ffa"), { mode: 0o700 }); // Exclusive creation; never adopt a race winner.
  const initial = new WorkspaceState({ format: "ffa-pi/1", status: "pending" });
  await atomicFile(join(root, ".ffa", "workspace.json"), JSON.stringify(initial) + "\n");
  return initial;
}
export async function saveReady(root: string, market: string) {
  await atomicFile(join(root, ".ffa", "workspace.json"), JSON.stringify({ format: "ffa-pi/1", status: "ready", market }) + "\n");
}

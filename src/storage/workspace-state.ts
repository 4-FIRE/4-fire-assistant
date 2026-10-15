import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { workspaceFormat } from "../common/version.js";
import { readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { initializeFileStorage } from "./initialize-storage.js";
import { WorkspaceState } from "../model/workspace.js";

export function parseState(value: unknown): WorkspaceState {
  requireThat(object(value) && value.format === workspaceFormat && (value.status === "pending" || value.status === "ready"), "不支持此工作区格式；请使用匹配的 ffa 版本。不会转换或覆盖数据。");
  requireThat(!Object.hasOwn(value, "market") || typeof value.market === "string" && value.market.trim() && value.market.length <= 256, "工作区市场无效。");
  requireThat(Object.keys(value).every(key => ["format", "status", "market"].includes(key)), "未知工作区字段。");
  return value as unknown as WorkspaceState;
}

export async function state(root: string): Promise<WorkspaceState | undefined> {
  try {
    const dir = await lstat(join(root, ".ffa"));
    requireThat(dir.isDirectory() && !dir.isSymbolicLink(), ".ffa 必须是普通目录。");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return new WorkspaceState(readJsonFile(root, ".ffa/workspace.json", parseState));
}
export async function begin(root: string): Promise<WorkspaceState> {
  const current = await state(root);
  if (current) return current;
  await mkdir(join(root, ".ffa"), { mode: 0o700 }); // Exclusive creation; never adopt a race winner.
  syncDirectory(root);
  initializeFileStorage(join(root, ".ffa"));
  const initial = new WorkspaceState({ format: workspaceFormat, status: "pending" });
  writeJsonFile(root, ".ffa/workspace.json", { ...initial }, parseState);
  return initial;
}
export async function saveReady(root: string, market?: string) {
  writeJsonFile(root, ".ffa/workspace.json", { format: workspaceFormat, status: "ready", ...(market === undefined ? {} : { market }) }, parseState);
}

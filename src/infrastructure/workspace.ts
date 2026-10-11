import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AssistantError } from "../application/ports.js";
import { emptyWorkspace, type WorkspaceConfig, type WorkspaceSource } from "../domain/workspace.js";
import { object, type Parameters } from "../domain/shared.js";
import { parseSourceConnection } from "./integrations/connection-config.js";
import { parseToolContract } from "./tool-contracts.js";

function invalid(): never { throw new AssistantError("WORKSPACE_INVALID", "工作区 config.json 结构无效；原文件未修改。请检查配置，不要删除工作区。"); }
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
export function parseWorkspaceSource(id: string, value: unknown): WorkspaceSource {
  if (typeof id !== "string" || !idPattern.test(id)) {
    throw new AssistantError("SOURCE_ID_INVALID", "来源 id 必须以小写字母开头，只含小写字母、数字和连字符，长度为 1–64；不能使用下划线。请修正 configure_source 的 id 后重试，不需要更换工作区。");
  }
  if (!object(value) || Object.keys(value).some(key => !["connection", "operations"].includes(key))) {
    throw new AssistantError("SOURCE_CONFIG_INVALID", "来源配置只接受 connection 和 operations。请修正接入参数，不需要更换工作区。");
  }
  const connection = parseSourceConnection(value.connection);
  const contract = parseToolContract({ version: 1, sourceId: id, operations: value.operations });
  if (!contract.operations.length) throw new AssistantError("SOURCE_CONFIG_INVALID", "operations 至少需要一个操作；请修正接入参数。");
  if (connection.transport === "cli" && contract.operations.some(op => !op.argv || !op.schema)) {
    throw new AssistantError("SOURCE_CONFIG_INVALID", "CLI 的每个操作都需要 argv 和 schema；请修正接入参数。");
  }
  return { connection: connection as unknown as Parameters, operations: contract.operations as unknown as Parameters[] };
}
export function parseWorkspace(value: unknown): WorkspaceConfig {
  if (object(value) && value.version !== 3) {
    throw new AssistantError("WORKSPACE_INVALID", "工作区版本不受支持，当前格式为 version=3。旧文件未修改；旧版工作区请保留并使用新的工作目录。");
  }
  if (!object(value) || value.version !== 3 || !object(value.sources) || !object(value.extensions) ||
      Object.keys(value).some(key => !["version", "initialization", "sources", "extensions"].includes(key))) invalid();
  const initialization = value.initialization;
  if (initialization !== null && (!object(initialization) ||
      Object.keys(initialization).some(key => !["market", "quoteRef", "historyRef", "completedAt"].includes(key)) ||
      !["market", "quoteRef", "historyRef", "completedAt"].every(key => typeof initialization[key] === "string" && String(initialization[key]).trim()))) invalid();
  for (const [id, grants] of Object.entries(value.extensions)) {
    if (!idPattern.test(id) || !object(grants) || Object.entries(grants).some(([role, caps]) =>
      !idPattern.test(role) || !Array.isArray(caps) || caps.some(cap => typeof cap !== "string" || !["read", "prepare", "compute"].includes(cap)))) invalid();
  }
  return { version: 3, initialization: initialization as WorkspaceConfig["initialization"],
    sources: Object.fromEntries(Object.entries(value.sources).map(([id, source]) => [id, parseWorkspaceSource(id, source)])),
    extensions: structuredClone(value.extensions) as WorkspaceConfig["extensions"] };
}
export async function readWorkspace(directory: string): Promise<WorkspaceConfig> {
  try { return parseWorkspace(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))); }
  catch (error) { if (error instanceof AssistantError) throw error; return invalid(); }
}
/** Caller holds the workspace lock. Publish only after the new file is flushed. */
export async function saveWorkspace(directory: string, value: WorkspaceConfig): Promise<void> {
  const data = parseWorkspace(value), temporary = join(directory, `.workspace-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(directory, "config.json"));
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

/** No writes before consent. Do not migrate, replace or follow a symlinked .ffa. */
export async function locateWorkspace(cwd: string, confirm: (root: string) => Promise<boolean>): Promise<{ root: string; directory: string } | undefined> {
  const root = await realpath(cwd), directory = join(root, ".ffa");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    await readWorkspace(directory);
    return { root, directory };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!await confirm(root)) return undefined;
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AssistantError("WORKSPACE_CHANGED", "工作区在确认期间发生变化；请重新启动。");
    throw error;
  }
  const file = await open(join(directory, "config.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(emptyWorkspace(), null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  return { root, directory };
}

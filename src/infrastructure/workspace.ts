import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AssistantError } from "../application/ports.js";
import { emptyWorkspace, type SetupDraft, type WorkspaceConfig } from "../domain/workspace.js";
import { object, type Parameters } from "../domain/shared.js";
import { parseConfig } from "./config.js";
import { parseToolContract } from "./tool-contracts.js";

function invalid(): never { throw new AssistantError("WORKSPACE_INVALID", "工作区配置损坏或不受支持；原文件保留，请修复后重试。"); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
export function parseSetupDraft(value: unknown): SetupDraft {
  if (!object(value) || Object.keys(value).some(key => key !== "sources") || !Array.isArray(value.sources) || value.sources.length > 64) invalid();
  const sources = value.sources.map(source => {
    if (!object(source) || Object.keys(source).some(key => !["name", "kind", "description", "location", "missing", "id", "connection", "operations", "discoveryArgs"].includes(key)) ||
        typeof source.name !== "string" || !source.name.trim() ||
        !["mcp", "cli"].includes(String(source.kind)) || typeof source.description !== "string" ||
        typeof source.location !== "string" || !strings(source.missing)) invalid();
    if (source.id !== undefined && (typeof source.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(source.id))) invalid();
    if (source.discoveryArgs !== undefined && (!strings(source.discoveryArgs) || source.discoveryArgs.some(arg => arg.includes("\0")))) invalid();
    let connection: Parameters | undefined;
    if (source.connection !== undefined) {
      const checked = parseConfig({ version: 1, sources: { draft: source.connection } }).sources!.draft!;
      if ((checked.transport === "cli") !== (source.kind === "cli")) invalid();
      connection = checked as unknown as Parameters;
    }
    let operations: Parameters[] | undefined;
    if (source.operations !== undefined) operations = parseToolContract({ version: 1, sourceId: "draft", operations: source.operations }).operations as unknown as Parameters[];
    return { name: source.name, kind: source.kind as "mcp" | "cli", description: source.description,
      location: source.location, missing: source.missing,
      ...(source.id ? { id: source.id as string } : {}), ...(connection ? { connection } : {}), ...(operations ? { operations } : {}),
      ...(source.discoveryArgs ? { discoveryArgs: source.discoveryArgs as string[] } : {}) };
  });
  return { sources };
}
export function parseWorkspace(value: unknown): WorkspaceConfig {
  if (!object(value) || value.version !== 1 || !["pending", "complete"].includes(String(value.initialization)) ||
      !Array.isArray(value.messages) || Object.keys(value).some(key => !["version", "initialization", "messages", "draft", "enabledSources", "extensions"].includes(key))) invalid();
  if (value.enabledSources !== undefined && (!strings(value.enabledSources) || !value.enabledSources.every(id => /^[a-z][a-z0-9-]{0,63}$/.test(id)))) invalid();
  if (value.extensions !== undefined && (!object(value.extensions) || Object.entries(value.extensions).some(([id, grants]) =>
    !/^[a-z][a-z0-9-]{0,63}$/.test(id) || !object(grants) || Object.entries(grants).some(([role, caps]) =>
      !/^[a-z][a-z0-9-]*$/.test(role) || !strings(caps) || caps.some(cap => !["read", "prepare", "compute"].includes(cap)))))) invalid();
  const messages = value.messages.map(message => {
    if (!object(message) || !["user", "assistant"].includes(String(message.role)) || typeof message.text !== "string") invalid();
    return { role: message.role as "user" | "assistant", text: message.text };
  });
  return { version: 1, initialization: value.initialization as "pending" | "complete", messages, draft: parseSetupDraft(value.draft),
    ...(value.extensions ? { extensions: value.extensions as Record<string, Record<string, string[]>> } : {}),
    ...(value.enabledSources ? { enabledSources: value.enabledSources as string[] } : {}) };
}
export async function readWorkspace(directory: string): Promise<WorkspaceConfig> {
  try { return parseWorkspace(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))); }
  catch (error) { if (error instanceof AssistantError) throw error; return invalid(); }
}
/** Caller holds the workspace instance lock. Flush before publishing the completion marker. */
export async function saveWorkspace(directory: string, value: WorkspaceConfig): Promise<void> {
  const data = parseWorkspace(value);
  const temporary = join(directory, `.setup-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(directory, "config.json"));
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

/** No writes occur before explicit consent. No ancestor search and no symlinked .ffa. */
export async function locateWorkspace(cwd: string, confirm: (root: string) => Promise<boolean>): Promise<string | undefined> {
  const root = await realpath(cwd);
  const directory = join(root, ".ffa");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    await readWorkspace(directory);
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!await confirm(root)) return undefined;
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    // Another process may have initialized it during confirmation. Never replace it.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AssistantError("WORKSPACE_CHANGED", "工作区在确认期间发生变化；请重新启动。");
    throw error;
  }
  // Exclusive creation prevents two bootstrap processes from publishing different drafts.
  const file = await open(join(directory, "config.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(emptyWorkspace(), null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  return directory;
}

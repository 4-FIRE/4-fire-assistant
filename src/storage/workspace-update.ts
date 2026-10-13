import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { atomicFile } from "../common/files.js";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { WorkspaceUpdateState } from "../model/workspace-update.js";
import type { Store } from "./store.js";

function validPlan(plan: unknown) {
  return object(plan) && typeof plan.summary === "string" && typeof plan.instructions === "string" &&
    Array.isArray(plan.internalFiles) && plan.internalFiles.every(path => typeof path === "string") &&
    Array.isArray(plan.requiredDocuments) && plan.requiredDocuments.every(path => typeof path === "string") &&
    Array.isArray(plan.documents) && plan.documents.every(item => object(item) &&
      typeof item.path === "string" && typeof item.change === "string");
}
export function readUpdateState(store: Store): WorkspaceUpdateState {
  const value = store.get<unknown>("workspace-update", "current");
  if (value === undefined) return { version: 1 };
  requireThat(object(value) && Number.isSafeInteger(value.version) && Number(value.version) >= 1, "工作区版本记录无效。");
  if (value.approvals !== undefined) {
    requireThat(Array.isArray(value.approvals) && value.approvals.every(item => object(item) &&
      Number.isSafeInteger(item.from) && Number(item.from) >= Number(value.version) && validPlan(item.plan)) &&
      new Set(value.approvals.map(item => item.from)).size === value.approvals.length, "后续版本确认记录无效。");
  }
  if (value.batch !== undefined) {
    const batch = value.batch;
    requireThat(object(batch) && typeof batch.id === "string" && /^[\da-f-]{36}$/.test(batch.id) &&
      batch.from === value.version && batch.to === Number(value.version) + 1 &&
      ["planning", "program", "documents"].includes(String(batch.stage)) && Array.isArray(batch.plans), "升级阶段记录无效。");
    for (const plan of batch.plans) requireThat(validPlan(plan), "升级方案记录无效。");
    requireThat(batch.stage === "planning" ? batch.plans.length === 0 : batch.plans.length > 0, "升级方案与阶段不一致。");
  }
  return value as unknown as WorkspaceUpdateState;
}
export function saveUpdateState(store: Store, value: WorkspaceUpdateState) {
  store.put("workspace-update", "current", value);
}

/** Reject aliases, directories and paths outside the declared file scope. */
export async function updateFile(root: string, path: string, internal: boolean): Promise<string> {
  const parts = path.split("/");
  requireThat(parts.every(part => part && part !== "." && part !== ".." && !part.includes("\\")) &&
    (internal ? parts[0] === ".ffa" && parts.length === 2 && !["owner.lock", "business.sqlite", "business.sqlite-wal", "business.sqlite-shm"].includes(parts[1]!) : parts[0] !== ".ffa"), "升级文件范围无效。");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    try {
      const info = await lstat(current);
      requireThat(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()), "升级文件不能使用别名或目录。");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
async function directory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(path);
  requireThat(info.isDirectory() && !info.isSymbolicLink(), "升级备份目录必须是普通目录。");
}
async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** A published segment is immutable. Incomplete attempts remain separate. */
export async function backupUpdate(root: string, store: Store, batch: string, from: number,
  segment: number, files: { path: string; internal: boolean }[], signal: AbortSignal) {
  const base = join(root, ".ffa", "upgrades");
  await directory(base);
  const version = join(base, `v${from}-${batch}`);
  await directory(version);
  const destination = join(version, String(segment));
  const expected = [...new Set(files.map(file => file.path))];
  let published = false;
  try {
    const info = await lstat(destination);
    published = true;
    requireThat(info.isDirectory() && !info.isSymbolicLink(), "升级备份不可读取。");
    const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
    requireThat(manifest.batch === batch && manifest.from === from && manifest.segment === segment &&
      Array.isArray(manifest.files) && manifest.database === "business.sqlite" &&
      JSON.stringify(manifest.files.map((file: { path: string }) => file.path)) === JSON.stringify(expected), "已有备份与升级范围不一致。");
    for (const file of manifest.files) {
      requireThat(typeof file.existed === "boolean" && (!file.existed || typeof file.copy === "string" && /^file-\d+$/.test(file.copy)), "备份文件清单无效。");
      if (file.existed) {
        const info = await lstat(join(destination, file.copy));
        requireThat(info.isFile() && !info.isSymbolicLink(), "备份文件不可读取。");
      }
    }
    const database = join(destination, "business.sqlite"), databaseInfo = await lstat(database);
    requireThat(databaseInfo.isFile() && !databaseInfo.isSymbolicLink(), "数据库备份不可读取。");
    const db = new DatabaseSync(database, { readOnly: true });
    try { requireThat(db.prepare("PRAGMA quick_check").get()?.quick_check === "ok", "数据库备份完整性检查失败。"); }
    finally { db.close(); }
    return;
  } catch (error) { if (published || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staging = join(version, `${segment}-pending-${randomUUID()}`);
  await directory(staging);
  const entries: { path: string; existed: boolean; copy?: string }[] = [];
  for (const [index, file] of files.entries()) {
    if (entries.some(entry => entry.path === file.path)) continue;
    signal.throwIfAborted();
    const source = await updateFile(root, file.path, file.internal);
    let content: Buffer;
    try { content = await readFile(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push({ path: file.path, existed: false }); continue;
    }
    const copy = `file-${index}`;
    const handle = await open(join(staging, copy), "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    entries.push({ path: file.path, existed: true, copy });
  }
  signal.throwIfAborted();
  const snapshot = join(staging, "business.sqlite");
  store.snapshot(snapshot);
  // SQLite creates its output using the process umask. Backups contain private records.
  const handle = await open(snapshot, "r");
  try { await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
  await atomicFile(join(staging, "manifest.json"), JSON.stringify({ batch, from, segment, files: entries, database: "business.sqlite" }) + "\n");
  signal.throwIfAborted();
  await rename(staging, destination);
  await syncDirectory(version);
  await syncDirectory(base);
  await syncDirectory(dirname(base));
}

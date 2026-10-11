import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AssistantError } from "../application/ports.js";

async function privateFile(path: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  await handle.close();
}

/**
 * SQLite's OS-backed exclusive file lock is released on process death.
 * Never unlink the file: replacing its inode would create two independent locks.
 * This file contains no business tables or records; it is only an ownership lock.
 */
export class InstanceLock {
  private closed = false;
  private constructor(private readonly database: DatabaseSync) {}
  static async acquire(directory: string): Promise<InstanceLock> {
    const path = join(directory, "instance.lock");
    await privateFile(path);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
      return new InstanceLock(db);
    } catch (error) {
      db.close();
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) {
        throw new AssistantError("INSTANCE_IN_USE", "另一个助手进程正在使用此数据目录。");
      }
      throw new AssistantError("LOCK_FAILED", "无法锁定数据目录。请检查目录权限和锁文件。");
    }
  }
  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
export interface ApplicationStorage {
  directory: string;
  storage: SqliteStorage;
  durability: { journalMode: "wal"; synchronous: 2 };
  close(): Promise<void>;
}
export async function openApplicationStorage(directory: string): Promise<ApplicationStorage> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  const lock = await InstanceLock.acquire(canonicalDirectory);
  let db: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
  try {
    const path = join(canonicalDirectory, "state.sqlite");
    await privateFile(path);
    db = await openNodeSqliteDatabase(path);
    await db.exec("PRAGMA synchronous = FULL");
    const sync = await db.get<{ synchronous: number }>("PRAGMA synchronous");
    const journal = await db.get<{ journal_mode: string }>("PRAGMA journal_mode");
    if (sync?.synchronous !== 2 || journal?.journal_mode !== "wal") {
      throw new AssistantError("DURABILITY_UNAVAILABLE", "存储未启用 WAL 日志模式和 FULL 同步模式。为保护记录，程序已停止启动。");
    }
    const storage = await SqliteStorage.open(db);
    let closed = false;
    return {
      directory: canonicalDirectory,
      storage,
      durability: { journalMode: "wal", synchronous: 2 },
      async close() {
        if (closed) return;
        // Retain ownership if close fails. Process exit, not another writer, releases it.
        await storage.close(BACKGROUND_CONTEXT);
        lock.close();
        closed = true;
      },
    };
  } catch (error) {
    try { await db?.close(); } finally { lock.close(); }
    throw error;
  }
}

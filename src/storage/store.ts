import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { lstatSync, openSync, closeSync, fsyncSync } from "node:fs";
import { canonical, type Json } from "../common/json.js";

function privateFile(path: string) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("内部状态不能是符号链接。");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(path, "a", 0o600); closeSync(fd);
}

/** One owner per real workspace. SQLite releases the lock on process death. */
export class Store {
  readonly #lock: DatabaseSync;
  readonly #db: DatabaseSync;
  #closed = false;
  #failed = false;
  constructor(directory: string, create = true) {
    privateFile(join(directory, "owner.lock"));
    this.#lock = new DatabaseSync(join(directory, "owner.lock"));
    try { this.#lock.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE"); }
    catch { this.#lock.close(); throw new Error("另一个 ffa 实例正在使用此工作区。"); }
    try {
      if (!create && !lstatSync(join(directory, "business.sqlite")).isFile()) throw new Error("交易账本缺失，禁止创建替代账本。");
      privateFile(join(directory, "business.sqlite"));
      this.#db = new DatabaseSync(join(directory, "business.sqlite"));
      try {
        this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
        if (this.#db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal" ||
            this.#db.prepare("PRAGMA synchronous").get()?.synchronous !== 2) throw new Error("交易存储需要 WAL/FULL。");
        const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
        if (version === 0 && create && this.#db.prepare("SELECT name FROM sqlite_master WHERE type=\'table\'").all().length === 0) {
          this.#db.exec("BEGIN IMMEDIATE; CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1; COMMIT");
        } else if (version !== 1) throw new Error("不支持此业务账本格式；不会重建或升级。");
        if (this.#db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("账本完整性检查失败。");
        this.#db.prepare("SELECT kind,id,value FROM records LIMIT 0").all();
      } catch (error) { this.#db.close(); throw error; }
    } catch (error) { this.#lock.close(); throw error; }
  }
  get healthy() { return !this.#closed && !this.#failed; }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.#db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  list<T>(kind: string): T[] {
    return this.#db.prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid").all(kind).map(row => JSON.parse(String(row.value)) as T);
  }
  put(kind: string, id: string, value: unknown): void {
    if (!this.healthy) throw new Error("业务存储不可写；请重启并核对交易记录。");
    const data = canonical(value);
    try { this.#db.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value").run(kind, id, data); }
    catch (error) { this.#failed = true; throw error; }
  }
  transaction<T>(work: () => T): T {
    if (!this.healthy) throw new Error("业务存储不可写。");
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.#db.exec("COMMIT"); return value; }
    catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { this.#failed = true; }
      throw error;
    }
  }
  snapshot(path: string) {
    if (!this.healthy) throw new Error("业务存储不可备份。");
    // VACUUM INTO creates a consistent SQLite snapshot and refuses an existing file.
    this.#db.prepare("VACUUM INTO ?").run(path);
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  audit(event: string, data: Json) {
    this.put("audit", crypto.randomUUID(), { event, at: new Date().toISOString(), data });
  }
  close() {
    if (this.#closed) return;
    try { this.#db.close(); }
    finally { try { this.#lock.close(); } finally { this.#closed = true; } }
  }
}

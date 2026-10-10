import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryPort, MemoryPage, MemorySummary } from "../application/memory.js";
import { AssistantError } from "../application/ports.js";

const validId = (id: string) => /^[a-z0-9][a-z0-9-]{0,127}$/.test(id);
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const summary = (id: string, content: string): MemorySummary => ({ id, revision: digest(content), summary: content.split("\n").find(line => line.trim())?.slice(0, 240) ?? "" });
function invalid(): never { throw new AssistantError("MEMORY_INVALID", "记忆标识、版本、内容或存储路径无效；原内容未覆盖。"); }

/** Workspace-local Markdown, atomic updates and optimistic concurrency. No second knowledge database. */
export class WorkspaceMemory implements MemoryPort {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private async root(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  }
  private async content(id: string): Promise<string | undefined> {
    if (!validId(id)) invalid();
    await this.root();
    let handle;
    try { handle = await open(join(this.directory, id + ".md"), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) invalid();
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  async list(query = "", offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || query.length > 2000) invalid();
    await this.root();
    const entries: MemorySummary[] = [];
    const files = (await readdir(this.directory)).filter(file => /^[a-z0-9][a-z0-9-]{0,127}\.md$/.test(file)).sort();
    for (const file of files.slice(offset, offset + 100)) {
      const id = file.slice(0, -3), content = await this.content(id);
      if (content !== undefined && (!query || content.toLowerCase().includes(query.toLowerCase()))) entries.push(summary(id, content));
    }
    return { entries, nextOffset: offset + 100 < files.length ? offset + 100 : null };
  }
  async read(id: string, offset = 0, revision?: string): Promise<MemoryPage | undefined> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0 && !revision) invalid();
    const content = await this.content(id);
    if (content === undefined) return undefined;
    const actual = digest(content);
    if (revision !== undefined && actual !== revision) throw new AssistantError("MEMORY_CHANGED", "记忆已改变，请重新读取后再继续。");
    return { id, revision: actual, content: content.slice(offset, offset + 16000), nextOffset: offset + 16000 < content.length ? offset + 16000 : null };
  }
  private async write(id: string, content: string, revision: string | undefined, immutable: boolean): Promise<MemorySummary> {
    if (!validId(id) || !content.trim() || Buffer.byteLength(content) > 1024 * 1024) invalid();
    const work = async () => {
      const previous = await this.content(id);
      if (previous !== undefined) {
        if (immutable && previous === content) return summary(id, previous);
        if (immutable || !revision || digest(previous) !== revision) throw new AssistantError("MEMORY_CHANGED", "记忆已存在或版本已改变；先读取，显式提供当前 revision 后再修改。");
      } else if (revision !== undefined) throw new AssistantError("MEMORY_CHANGED", "待修改的记忆不存在。");
      const temporary = join(this.directory, ".memory-" + randomUUID() + ".tmp");
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.directory, id + ".md"));
        const parent = await open(this.directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
      return summary(id, content);
    };
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  async save(content: string, id = "note-" + randomUUID(), revision?: string) {
    if (id.startsWith("system-")) invalid();
    return this.write(id, content, revision, false);
  }
  async record(key: string, content: string, replace = false) {
    const id = "system-" + digest(key);
    if (!replace) return this.write(id, content, undefined, true);
    const previous = await this.content(id);
    if (previous === content) return summary(id, previous);
    if (previous !== undefined) await this.write("system-" + digest(key + ":archive:" + digest(previous)), previous, undefined, true);
    return this.write(id, content, previous === undefined ? undefined : digest(previous), false);
  }
  recorded(key: string) { return this.content("system-" + digest(key)); }
}

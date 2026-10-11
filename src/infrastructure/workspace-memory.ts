import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { MemoryPort, MemoryMatch, MemoryResults } from "../application/memory.js";
import { AssistantError } from "../application/ports.js";

const roots = ["AGENTS.md", "README.md", "BOOTSTRAP.md", "SOUL.md", "areas", "projects", "knowledge", "sources", "roles", ".agents/skills", "extensions", "scratch", "docs"];
const excluded = new Set(["node_modules", "runs", "__pycache__"]);
const maxBytes = 1024 * 1024;

/** Search the current Markdown sources without copying their content into a store. */
export class WorkspaceMemory implements MemoryPort {
  constructor(private readonly directory: string) {}
  async list(query = "", offset = 0, scope?: string): Promise<MemoryResults> {
    if (typeof query !== "string" || query.length > 2000 || !Number.isSafeInteger(offset) || offset < 0 ||
        scope !== undefined && (!roots.some(path => scope === path || scope.startsWith(path + "/")) || scope.split("/").some((part, i) => !part || part === "." || part === ".." || part.startsWith(".") && !(i === 0 && part === ".agents") || excluded.has(part)) || scope.includes("\\"))) {
      throw new AssistantError("MEMORY_INVALID", "请指定资料目录内的相对路径、查询词和有效分页偏移。");
    }
    const root = await realpath(this.directory), files: string[] = [], skipped: string[] = [];
    let visited = 0;
    const walk = async (path: string): Promise<void> => {
      if (++visited > 20000) throw new AssistantError("MEMORY_SCOPE_TOO_LARGE", "资料范围过大，请用 scope 限定到相关目录。");
      let info;
      try { info = await lstat(join(root, path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (info.isSymbolicLink()) { skipped.push(path); return; }
      if (info.isDirectory()) {
        for (const name of (await readdir(join(root, path))).sort()) {
          if (!name.startsWith(".") && !excluded.has(name)) await walk(path + "/" + name);
        }
      } else if (info.isFile() && path.endsWith(".md")) {
        if (info.size > maxBytes) skipped.push(path); else files.push(path);
      }
    };
    // Check ancestors for both scoped searches and the allowlisted hidden subtree.
    for (const path of scope ? [scope] : roots) {
      const parts = path.split("/");
      let accessible = true;
      for (let i = 1; i < parts.length; i++) {
        try {
          if ((await lstat(join(root, ...parts.slice(0, i)))).isSymbolicLink()) { skipped.push(path); accessible = false; break; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { accessible = false; break; } throw error; }
      }
      if (accessible) await walk(path);
    }
    const entries: MemoryMatch[] = [], needle = query.toLocaleLowerCase();
    let matched = 0;
    for (const path of files.sort()) {
      const absolute = join(root, path), actual = await realpath(absolute);
      if (relative(root, actual) !== path) { skipped.push(path); continue; }
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        if ((await handle.stat()).size > maxBytes) { skipped.push(path); continue; }
        content = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const at = needle && !path.toLocaleLowerCase().includes(needle) ? content.toLocaleLowerCase().indexOf(needle) : 0;
      if (at < 0) continue;
      if (matched++ < offset) continue;
      if (entries.length === 30) return { entries, nextOffset: offset + entries.length, skipped };
      const start = Math.max(0, at - 100);
      entries.push({ path, line: content.slice(0, start).split("\n").length, excerpt: content.slice(start, start + 600) });
    }
    return { entries, nextOffset: null, skipped };
  }
}

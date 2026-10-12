import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { atomicFile } from "../common/files.js";

export class PermissionFile {
  readonly path: string;
  constructor(private readonly root: string) { this.path = join(root, ".ffa", "permissions.json"); }
  private check() {
    const directory = join(this.root, ".ffa");
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== join(realpathSync(this.root), ".ffa")) {
      throw new Error("权限目录不能是符号链接。");
    }
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error("权限文件不能是符号链接。");
  }
  read() { this.check(); return readFileSync(this.path, "utf8"); }
  async initialize(content: string) {
    await mkdir(join(this.root, ".ffa"), { recursive: true }); this.check();
    try {
      const file = await open(this.path, "wx", 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  async write(content: string) { this.check(); await atomicFile(this.path, content); }
}

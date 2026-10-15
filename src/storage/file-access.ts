import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { internalPath, readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";

export function fileId(id: string) {
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id), "内部记录 ID 无效。"); return id;
}
export function privateDirectory(root: string, relative: string) {
  const parts = relative.split("/");
  let parent = root;
  for (const part of parts) {
    fileId(part);
    const path = join(parent, part);
    try { mkdirSync(path, { mode: 0o700 }); syncDirectory(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    requireThat(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "内部状态目录无效。"); parent = path;
  }
}
export function entries(root: string, relative: string, directories = false): string[] {
  // internalPath checks each parent; the unused final component is not opened.
  const path = dirname(internalPath(root, `${relative}/.scan`));
  return readdirSync(path).filter(name => !name.startsWith(".tmp-")).sort().map(name => {
    const info = lstatSync(join(path, name));
    requireThat(!info.isSymbolicLink() && (directories ? info.isDirectory() : info.isFile()), "内部状态包含非法文件。");
    return name;
  });
}

/** Shared write health, not a record database. Reads remain available for diagnosis. */
export class FileAccess {
  #closed = false;
  #failed = false;
  constructor(readonly directory: string) {}
  get healthy() { return !this.#closed && !this.#failed; }
  check() { requireThat(!this.#closed, "工作区存储已关闭。"); }
  read<T>(path: string, validate: (value: unknown) => T) { this.check(); return readJsonFile(this.directory, path, validate); }
  write<T>(path: string, value: unknown, validate: (value: unknown) => T) {
    requireThat(this.healthy, "业务存储不可写；请重载并核对记录。");
    canonical(validate(value));
    try { writeJsonFile(this.directory, path, value, validate); }
    catch (error) { this.#failed = true; throw error; }
  }
  mutate(work: () => void) {
    requireThat(this.healthy, "业务存储不可写。");
    try { work(); } catch (error) { this.#failed = true; throw error; }
  }
  close() { this.#closed = true; }
}

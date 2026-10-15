import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { canonical, object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { internalPath, readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { entries, fileId, privateDirectory } from "./file-access.js";
import { parseCallRecord, type CallRecord } from "./call-record.js";
import { parseCallResult } from "./call-result.js";

export const archiveCallLimit = 128;
export const archiveByteLimit = 16 * 1024 * 1024;
interface ArchiveIndex { calls: CallRecord[]; results: string[]; resultBytes: number }
interface Archive { path: string; index: ArchiveIndex }

function parseIndex(value: unknown): ArchiveIndex {
  requireThat(object(value) && Object.keys(value).sort().join() === "calls,resultBytes,results" &&
    Array.isArray(value.calls) && value.calls.length > 0 && value.calls.length <= archiveCallLimit &&
    Array.isArray(value.results) && Number.isSafeInteger(value.resultBytes) && Number(value.resultBytes) > 0,
  "调用归档索引无效。");
  const calls = value.calls.map(parseCallRecord), ids = new Set<string>();
  for (const { intent } of calls) {
    requireThat(intent.permission === "allow" && !["pending", "dispatched"].includes(intent.state), "调用不能归档。");
    requireThat(!ids.has(intent.id), "归档调用 ID 重复。"); ids.add(intent.id);
  }
  const results = new Set<string>();
  for (const id of value.results) {
    requireThat(typeof id === "string" && ids.has(id) && !results.has(id), "归档结果引用无效。"); results.add(id);
  }
  requireThat(calls.every(call => !call.receipt || results.has(call.intent.id)), "归档回执缺少正文。");
  return { calls, results: [...results], resultBytes: Number(value.resultBytes) };
}

/** Open ordinary files only, including when another local process changes a path. */
export function readInternalBytes(directory: string, relative: string): Buffer {
  const fd = openSync(internalPath(directory, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireThat(fstatSync(fd).isFile(), "归档只能读取普通文件。");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Immutable batches: metadata stays readable without inflating historical result bodies. */
export class CallArchives {
  readonly #calls = new Map<string, { record: CallRecord; archive: Archive }>();
  constructor(private readonly directory: string) {
    // No archive directory is needed until the first batch is published.
    try { lstatSync(join(directory, "archives")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of entries(directory, "archives", true)) {
      fileId(name);
      const path = "archives/" + name;
      requireThat(entries(directory, path).join() === "records.json,results.json.gz", "归档文件不完整。");
      const index = readJsonFile(directory, path + "/records.json", parseIndex);
      requireThat(lstatSync(internalPath(directory, path + "/results.json.gz")).size > 0, "归档正文为空。");
      this.add({ path, index });
    }
  }
  private add(archive: Archive) {
    for (const record of archive.index.calls) {
      requireThat(!this.#calls.has(record.intent.id), "调用出现在多个归档中。");
      this.#calls.set(record.intent.id, { record, archive });
    }
  }
  list() { return [...this.#calls.values()].map(value => structuredClone(value.record)); }
  has(id: string) { return this.#calls.has(id); }
  get(id: string) { const saved = this.#calls.get(id); return saved && structuredClone(saved.record); }
  hasResult(id: string) { return this.#calls.get(id)?.archive.index.results.includes(id) ?? false; }
  private readResults(archive: Archive): Record<string, string> {
    requireThat(canonical(readJsonFile(this.directory, archive.path + "/records.json", parseIndex)) === canonical(archive.index),
      "归档索引已变化；保留散文件。");
    const bytes = gunzipSync(readInternalBytes(this.directory, archive.path + "/results.json.gz"),
      { maxOutputLength: archive.index.resultBytes });
    requireThat(bytes.length === archive.index.resultBytes, "归档正文长度不符。");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    requireThat(object(value) && canonical(Object.keys(value).sort()) === canonical([...archive.index.results].sort()) &&
      Object.values(value).every(item => typeof item === "string"), "归档正文与索引不符。");
    return value as Record<string, string>;
  }
  result(id: string) {
    const saved = this.#calls.get(id);
    if (!saved || !this.hasResult(id)) return undefined;
    return parseCallResult(JSON.parse(this.readResults(saved.archive)[id]!));
  }
  /** Reads each batch once. Used before removing redundant loose files, including after interruption. */
  *batches(ids: ReadonlySet<string>) {
    const seen = new Set<Archive>();
    for (const { record, archive } of this.#calls.values()) {
      if (seen.has(archive) || !ids.has(record.intent.id)) continue;
      seen.add(archive);
      yield { calls: structuredClone(archive.index.calls), results: () => this.readResults(archive) };
    }
  }
  publish(calls: CallRecord[], results: Record<string, string>) {
    requireThat(calls.every(call => !this.#calls.has(call.intent.id)), "已归档调用不能再次归档。");
    for (const content of Object.values(results)) parseCallResult(JSON.parse(content));
    const bytes = Buffer.from(JSON.stringify(results) + "\n");
    const index = parseIndex({ calls, results: Object.keys(results), resultBytes: bytes.length });
    const name = new Date().toISOString().replace(/[-:.]/g, "") + "-" + randomUUID();
    privateDirectory(this.directory, "archives");
    const parent = join(this.directory, "archives"), temporary = ".tmp-" + randomUUID();
    // Validate the parent before mkdir; the temporary batch is never an active archive.
    internalPath(this.directory, "archives/.scan");
    mkdirSync(join(parent, temporary), { mode: 0o700 });
    const relative = "archives/" + temporary;
    const fd = openSync(internalPath(this.directory, relative + "/results.json.gz"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, gzipSync(bytes)); fsyncSync(fd); } finally { closeSync(fd); }
    writeJsonFile(this.directory, relative + "/records.json", index, parseIndex, true);
    const saved = readJsonFile(this.directory, relative + "/records.json", parseIndex);
    requireThat(canonical(saved) === canonical(index) &&
      gunzipSync(readInternalBytes(this.directory, relative + "/results.json.gz"), { maxOutputLength: bytes.length }).equals(bytes),
    "归档写入不能核实；保留原文件。");
    syncDirectory(join(parent, temporary));
    renameSync(join(parent, temporary), join(parent, name));
    syncDirectory(parent);
    this.add({ path: "archives/" + name, index: saved });
  }
}

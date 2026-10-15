import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { internalPath, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { Receipt } from "../model/receipt.js";
import { parseCallResult, type CallResult } from "./call-result.js";
import { canonical } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { parseCallRecord, type CallRecord } from "./call-record.js";
import { entries, fileId, type FileAccess } from "./file-access.js";
import { CallArchives, archiveByteLimit, archiveCallLimit, readInternalBytes } from "./call-archives.js";

export class CallFiles {
  readonly #receipts = new Map<string, string>();
  readonly #events = new Set<string>();
  readonly #archives: CallArchives;
  constructor(private readonly files: FileAccess) {
    this.#archives = new CallArchives(files.directory);
    for (const name of entries(files.directory, "results")) {
      requireThat(name.endsWith(".json"), "未知结果文件。"); fileId(name.slice(0, -5));
    }
    for (const record of this.list()) {
      if (record.receipt) {
        requireThat(!this.#receipts.has(record.receipt.id), "回执重复关联。");
        this.#receipts.set(record.receipt.id, record.intent.id);
        // Check the reference without parsing historical result bodies.
        requireThat(this.#archives.hasResult(record.intent.id) ||
          lstatSync(internalPath(this.files.directory, this.resultPath(record.intent.id))).isFile(), "调用结果正文缺失。");
      }
      for (const event of record.events) {
        requireThat(!this.#events.has(event.id), "审计事件 ID 重复。"); this.#events.add(event.id);
      }
    }
  }
  list() {
    this.files.check();
    const records = new Map(this.#archives.list().map(record => [record.intent.id, record]));
    for (const name of entries(this.files.directory, "calls")) {
      requireThat(name.endsWith(".json"), "未知调用文件。");
      const id = fileId(name.slice(0, -5)), record = this.get(id)!;
      records.set(id, record);
    }
    return [...records.values()];
  }
  get(id: string): CallRecord | undefined {
    this.files.check();
    const path = "calls/" + fileId(id) + ".json", archived = this.#archives.get(id);
    try {
      const record = this.files.read(path, parseCallRecord);
      requireThat(record.intent.id === id, "调用文件名与 ID 不一致。");
      requireThat(!archived || canonical(archived) === canonical(record), "散文件与归档调用不一致。");
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return archived; throw error; }
  }
  receipt(id: string) {
    this.files.check();
    const intent = this.#receipts.get(fileId(id)); if (!intent) return undefined;
    const record = this.get(intent);
    requireThat(record?.receipt?.id === id, "回执索引与文件不一致。");
    const { provider, operation, parameters, binding } = record.intent;
    const path = this.resultPath(intent), dataPath = internalPath(this.files.directory, path);
    if (!existsSync(dataPath)) {
      const result = this.#archives.result(intent);
      requireThat(result, "调用结果正文缺失。");
      this.files.mutate(() => {
        requireThat(writeJsonFile(this.files.directory, path, result, parseCallResult, true), "恢复结果正文时文件已存在。");
      });
    }
    return new Receipt({ ...record.receipt, provider, operation, parameters, binding, dataPath });
  }
  private resultPath(id: string) { return "results/" + fileId(id) + ".json"; }
  /** The service selects eligible IDs; storage publishes complete batches before removing duplicates. */
  archive(ids: string[]) {
    this.files.mutate(() => {
      let batch: CallRecord[] = [], results: Record<string, string> = {}, size = 0;
      const publish = () => {
        if (batch.length) this.#archives.publish(batch, results);
        batch = []; results = {}; size = 0;
      };
      for (const id of ids) {
        if (this.#archives.has(id)) continue;
        const record = this.get(id);
        requireThat(record, "待归档调用不存在。");
        const path = this.resultPath(id), exists = existsSync(internalPath(this.files.directory, path));
        requireThat(!record.receipt || exists, "待归档回执缺少结果正文。");
        const original = exists ? readInternalBytes(this.files.directory, path) : undefined;
        const content = original?.toString("utf8");
        requireThat(content === undefined || Buffer.from(content).equals(original!), "结果文件不是有效 UTF-8；保留原文件。");
        const bytes = original?.length ?? 0;
        if (batch.length >= archiveCallLimit || (batch.length > 0 && size + bytes > archiveByteLimit)) publish();
        batch.push(record);
        if (content !== undefined) results[id] = content;
        size += bytes;
      }
      publish();
      this.removeArchivedCopies();
    });
  }
  private removeArchivedCopies() {
    const loose = new Set(["calls", "results"].flatMap(directory =>
      entries(this.files.directory, directory).map(name => name.slice(0, -5))));
    for (const batch of this.#archives.batches(loose)) {
      const copies = batch.calls.filter(({ intent }) => loose.has(intent.id));
      const results = batch.results(); // Verify the archive before removing any source in this batch.
      for (const record of copies) {
        requireThat(canonical(this.get(record.intent.id)) === canonical(record), "归档后调用已变化。");
        const path = this.resultPath(record.intent.id);
        if (existsSync(internalPath(this.files.directory, path))) {
          requireThat(Object.hasOwn(results, record.intent.id) &&
            canonical(this.files.read(path, parseCallResult)) === canonical(parseCallResult(JSON.parse(results[record.intent.id]!))),
          "归档后结果已变化；保留散文件。");
        }
      }
      // Removing metadata first never leaves a live receipt pointing only to a deleted loose body.
      for (const { intent } of copies) this.removeCopy("calls/" + intent.id + ".json");
      syncDirectory(join(this.files.directory, "calls"));
      for (const { intent } of copies) this.removeCopy(this.resultPath(intent.id));
      syncDirectory(join(this.files.directory, "results"));
    }
  }
  private removeCopy(path: string) {
    try { unlinkSync(internalPath(this.files.directory, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  save(value: CallRecord, result?: CallResult) {
    const record = parseCallRecord(value), previous = this.get(record.intent.id);
    requireThat(!this.#archives.has(record.intent.id), "已归档调用不可改写。");
    requireThat(record.events.length === (previous?.events.length ?? 0) + 1 &&
      canonical(record.events.slice(0, -1)) === canonical(previous?.events ?? []), "审计事件只能追加。");
    if (previous) {
      for (const key of ["id", "session", "provider", "operation", "parameters", "binding", "createdAt", "permission"] as const) {
        requireThat(canonical(record.intent[key]) === canonical(previous.intent[key]), "不能修改历史调用身份或参数。");
      }
      if (previous.receipt) requireThat(canonical(previous.receipt) === canonical(record.receipt), "不能覆盖已有回执。");
      if (previous.intent.attempt) requireThat(canonical(previous.intent.attempt) === canonical(record.intent.attempt), "不能覆盖已有发送尝试。");
      if (previous.intent.observation) {
        for (const key of ["observation", "outcome", "receiptId"] as const) {
          requireThat(canonical(previous.intent[key]) === canonical(record.intent[key]), "不能覆盖已有观察结果。");
        }
      }
    }

    const event = record.events.at(-1)!;
    requireThat(!this.#events.has(event.id), "审计事件 ID 已存在。");
    if (record.receipt && !previous?.receipt) requireThat(!this.#receipts.has(record.receipt.id), "回执 ID 已存在。");
    requireThat(!!result === !!(record.receipt && !previous?.receipt), "新增回执必须同时保存结果正文。");
    if (result && record.receipt) {
      parseCallResult(result);
      this.files.mutate(() => {
        requireThat(writeJsonFile(this.files.directory, this.resultPath(record.intent.id), result, parseCallResult, true), "结果正文已存在，不能覆盖。");
      });
    }
    // A crash here can leave an unreferenced result, but never a committed reference to an unwritten body.
    this.files.write("calls/" + fileId(record.intent.id) + ".json", record, parseCallRecord);
    this.#events.add(event.id);
    if (record.receipt) this.#receipts.set(record.receipt.id, record.intent.id);
  }
}

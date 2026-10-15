import { lstatSync } from "node:fs";
import { internalPath, writeJsonFile } from "./atomic-json.js";
import { Receipt } from "../model/receipt.js";
import { parseCallResult, type CallResult } from "./call-result.js";
import { canonical } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { parseCallRecord, type CallRecord } from "./call-record.js";
import { entries, fileId, type FileAccess } from "./file-access.js";

export class CallFiles {
  readonly #receipts = new Map<string, string>();
  readonly #events = new Set<string>();
  constructor(private readonly files: FileAccess) {
    for (const name of entries(files.directory, "results")) {
      requireThat(name.endsWith(".json"), "未知结果文件。"); fileId(name.slice(0, -5));
    }
    for (const record of this.list()) {
      if (record.receipt) {
        requireThat(!this.#receipts.has(record.receipt.id), "回执重复关联。");
        this.#receipts.set(record.receipt.id, record.intent.id);
        // Check the reference without parsing historical result bodies.
        requireThat(lstatSync(internalPath(this.files.directory, this.resultPath(record.intent.id))).isFile(), "调用结果正文缺失。");
      }
      for (const event of record.events) {
        requireThat(!this.#events.has(event.id), "审计事件 ID 重复。"); this.#events.add(event.id);
      }
    }
  }
  list() {
    this.files.check();
    return entries(this.files.directory, "calls").map(name => {
      requireThat(name.endsWith(".json"), "未知调用文件。");
      const id = fileId(name.slice(0, -5)), record = this.files.read("calls/" + name, parseCallRecord);
      requireThat(record.intent.id === id, "调用文件名与 ID 不一致。"); return record;
    });
  }
  get(id: string): CallRecord | undefined {
    const path = "calls/" + fileId(id) + ".json";
    try {
      const record = this.files.read(path, parseCallRecord);
      requireThat(record.intent.id === id, "调用文件名与 ID 不一致。"); return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  receipt(id: string) {
    this.files.check();
    const intent = this.#receipts.get(fileId(id)); if (!intent) return undefined;
    const record = this.get(intent);
    requireThat(record?.receipt?.id === id, "回执索引与文件不一致。");
    const { provider, operation, parameters, binding } = record.intent;
    return new Receipt({ ...record.receipt, provider, operation, parameters, binding,
      dataPath: internalPath(this.files.directory, this.resultPath(intent)) });
  }
  private resultPath(id: string) { return "results/" + fileId(id) + ".json"; }
  save(value: CallRecord, result?: CallResult) {
    const record = parseCallRecord(value), previous = this.get(record.intent.id);
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

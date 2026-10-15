import type { CallFiles } from "../../storage/call-files.js";
import { requireThat } from "../../common/validation.js";

export class RecordService {
  constructor(private readonly calls: CallFiles) {}
  read(kind: "receipt" | "intent", id: string) {
    requireThat(kind === "receipt" || kind === "intent", "记录类别不可读取。");
    const value = kind === "intent" ? this.calls.get(id)?.intent : this.calls.receipt(id);
    requireThat(value, "记录不存在。"); return value;
  }
}

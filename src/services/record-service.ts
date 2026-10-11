import type { Store } from "../storage/store.js";
import { requireThat } from "../common/validation.js";

export class RecordService {
  constructor(private readonly store: Store) {}
  read(kind: "receipt" | "intent", id: string) {
    requireThat(kind === "receipt" || kind === "intent", "记录类别不可读取。");
    const value = this.store.get(kind, id);
    requireThat(value, "记录不存在。"); return value;
  }
}

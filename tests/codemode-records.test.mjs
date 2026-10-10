import { test } from "node:test";
import assert from "node:assert/strict";
import { codemodeRecordPage } from "../dist/infrastructure/codemode.js";

test("large nested-call records can be reconstructed without losing results or diagnostics", () => {
  const record = { script: "return 1", state: "failed", calls: {
    0: { name: "read", state: "completed", result: { content: [{ type: "text", text: "数据".repeat(40000) }], details: { truncated: true }, diagnostics: [{ code: "truncated" }] } },
    1: { name: "python", state: "started", result: null },
  } };
  let offset = 0, text = "";
  do {
    const page = codemodeRecordPage(record, offset, 16000);
    assert.ok(page.text.length <= 16000);
    text += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(text), record);
  for (const args of [[-1, 10], [0, 0], [0, 16001], [0.5, 1]]) {
    assert.throws(() => codemodeRecordPage(record, ...args), { code: "RUN_WINDOW" });
  }
});

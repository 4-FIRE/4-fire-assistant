import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../../dist/integrations/process.js";
import { callResult } from "../../dist/storage/call-result.js";

test("JSON process output keeps distinct diagnostics without a second stdout encoding", async () => {
  const observation = await runCommand("python3", ["-c", "import json,sys; sys.stderr.write('notice'); print(json.dumps({'value':42}))"],
    undefined, process.cwd(), {});
  assert.equal(observation.success, true);
  const original = structuredClone(observation);
  assert.deepEqual(callResult(observation), { data: { value: 42 }, raw: { stderr: "notice", exitCode: 0, incomplete: false } });
  assert.deepEqual(observation, original);
});

test("non-JSON process output preserves both streams and the exit status exactly once", async () => {
  const observation = await runCommand("python3", ["-c", "import sys; print('plain output'); sys.stderr.write('failure'); sys.exit(2)"],
    undefined, process.cwd(), {});
  assert.equal(observation.success, false);
  assert.deepEqual(callResult(observation), {
    data: { stdout: "plain output\n", stderr: "failure", exitCode: 2 }, raw: { incomplete: false },
  });
});

test("JSON whitespace removal preserves whitespace and escaped quotes inside strings", () => {
  const data = { value: 'a "quoted" word\nand a backslash \\ with spaces' };
  const stdout = JSON.stringify(data, null, 2) + "\n";
  assert.deepEqual(callResult({ success: true, data, raw: { stdout } }), { data, raw: {} });
});

test("stdout with number precision lost by JSON.parse remains original evidence", () => {
  const stdout = '{ "value": 9007199254740993 }';
  const data = JSON.parse(stdout);
  assert.equal(data.value, 9007199254740992);
  assert.deepEqual(callResult({ success: true, data, raw: { stdout } }), { data, raw: { stdout } });
});

test("distinct original diagnostics and primitive raw values are never removed", () => {
  assert.deepEqual(callResult({ success: false, data: { code: 1 }, raw: { stdout: '{"different":2}', code: 2 } }),
    { data: { code: 1 }, raw: { stdout: '{"different":2}', code: 2 } });
  assert.deepEqual(callResult({ success: false, data: null, raw: "original diagnostic" }), { data: null, raw: "original diagnostic" });
});

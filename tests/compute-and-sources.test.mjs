import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSource, sourceData } from "../dist/services/source-config.js";
import { runCommand } from "../dist/integrations/process.js";
import { runPython, ownerParts } from "../dist/services/research-service.js";

const cli = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf", operations: [{
  name: "print", description: "Print a literal argument", effect: "observe", assessment: "understood", analysis: { purpose: "Read local data", basis: "Local CLI contract", consequences: "No business state change", related: [], impacts: [], execution: "confirmation" },
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  argv: ["%s", { parameter: "text" }]
}] };
test("CLI contracts require explicit binding and credential references", () => {
  assert.deepEqual(sourceData(parseSource(cli)), cli);
  assert.throws(() => parseSource({ ...cli, env: { SECRET: "literal-secret" } }));
  assert.throws(() => parseSource({ ...cli, command: "printf" }));
  assert.throws(() => parseSource({ ...cli, operations: [{ ...cli.operations[0], argv: [] }] }));
  assert.throws(() => parseSource({ ...cli, operations: [{ ...cli.operations[0], effect: "change", assessment: "understood", analysis: { purpose: "Check controlled execution", basis: "Local CLI contract", consequences: "Requires review", related: [], impacts: ["orders"], execution: "independent" } }] }));
});
test("real process arguments do not interpret shell metacharacters", async () => {
  const literal = "$(echo unsafe); & | >";
  const value = await runCommand("/usr/bin/printf", ["%s", literal], undefined, process.cwd(), {});
  assert.equal(value.success, true);
  assert.equal(value.data.stdout, literal);
});
test("ordinary Python saves results and cancellation without requiring a project", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-python-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await runPython(root, "/usr/bin/python3", { code: "import json\nimport ffa_compute\nprint(json.load(open('inputs.json'))['n'] * 2)", inputs: { n: 21 } });
  assert.equal(first.output, 42); assert.equal(first.state, "completed");
  assert.equal(JSON.parse(await readFile(join(root, first.path, "manifest.json"), "utf8")).state, "completed");
  const failed = await runPython(root, "/usr/bin/python3", { code: "raise ValueError('bad input')", inputs: null, owner: "projects/risk" });
  assert.equal(failed.state, "failed");
  const controller = new AbortController();
  const pending = runPython(root, "/usr/bin/python3", { code: "import time\ntime.sleep(30)", inputs: null }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  const cancelled = await pending; clearTimeout(timer);
  assert.equal(cancelled.state, "cancelled");
});
test("compute rejects path traversal and symlinked output roots", async t => {
  for (const owner of ["../x", "projects/../x", "projects/.hidden", "scratch", "/tmp/x"]) assert.throws(() => ownerParts(owner));
  const root = await mkdtemp(join(tmpdir(), "ffa-path-")), outside = await mkdtemp(join(tmpdir(), "ffa-outside-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, join(root, "scratch"));
  await assert.rejects(runPython(root, "/usr/bin/python3", { code: "print(1)", inputs: null }));
});

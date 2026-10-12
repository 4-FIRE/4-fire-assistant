import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { watch } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { host } from "./helpers/pi-host.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertExpertBranch } from "../dist/integrations/expert-tools.js";

const cli = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf", operations: [
  { name: "echo", description: "Read JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
] };

test("old tool references cannot access a reopened workspace instance", async t => {
  const { session } = await host(t, "ready", [cli]);
  const old = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const first = await old.execute("first", { provider: "local", operation: "echo", parameters: { n: 1 } });
  assert.equal(first.structuredContent.success, true);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  await assert.rejects(old.execute("closed", { provider: "local", operation: "echo", parameters: {} }));
  await session.extensionRunner.emit({ type: "session_start" });
  await assert.rejects(old.execute("reopened", { provider: "local", operation: "echo", parameters: {} }));
  const fresh = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const next = await fresh.execute("fresh", { provider: "local", operation: "echo", parameters: { n: 2 } });
  assert.equal(next.structuredContent.success, true);
  assert.deepEqual(next.structuredContent.data, { n: 2 });
  assert.notEqual(next.structuredContent.intentId, first.structuredContent.intentId);
});

test("workspace shutdown waits for a cancelled external call to save its unknown result", { timeout: 15_000 }, async t => {
  const code = "import json,sys,time\nfrom pathlib import Path\np=json.load(sys.stdin)\nPath(p['file']).write_text('sent')\ntime.sleep(60)";
  const provider = { id: "local", kind: "cli", command: "/usr/bin/python3", coverage: { basis: "Local file calculation", limitations: [] },
    operations: [{ name: "write", description: "Write local marker and wait", inputSchema: { type: "object" }, argv: ["-c", code], stdin: true }] };
  const { root, session } = await host(t, "ready", [provider], { default: "allow", tools: {} });
  let shutdown;
  const watcher = watch(root, (_event, path) => {
    if (path === "marker") shutdown ??= session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  });
  t.after(() => watcher.close());
  const call = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const result = await call.execute("write", { provider: "local", operation: "write", parameters: { file: join(root, "marker") } });
  await shutdown;
  assert.equal(result.structuredContent.state, "unknown");
  assert.equal(await readFile(join(root, "marker"), "utf8"), "sent");
  const db = new DatabaseSync(join(root, ".ffa/business.sqlite"), { readOnly: true });
  try {
    const intent = JSON.parse(db.prepare("SELECT value FROM records WHERE kind='intent' AND id=?").get(result.structuredContent.intentId).value);
    assert.equal(intent.state, "unknown"); assert.ok(intent.attempt);
  } finally { db.close(); }
  await assert.rejects(call.execute("closed", { record: { kind: "intent", id: result.structuredContent.intentId } }));
});

test("source-loaded Python tools retain package library access after module moves", async t => {
  const { root, session } = await host(t, "ready");
  const tool = session.agent.state.tools.find(tool => tool.name === "ffa_python");
  const answer = await tool.execute("library", { code: "import ffa_compute\nprint(42)" });
  assert.equal(answer.structuredContent.state, "completed");
  assert.equal(answer.structuredContent.output, 42);
  const directory = join(root, answer.structuredContent.path);
  assert.ok((await readdir(directory)).includes("main.py"));
  assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).state, "completed");
});

test("expert branch checks permit normal appends but reject navigation away from the dispatching ancestor", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendCustomEntry("local-root", {});
  const anchor = manager.appendCustomEntry("local-dispatch", {}), sessionId = manager.getSessionId();
  manager.appendCustomEntry("ffa.expert", { id: "first-reference" });
  assert.doesNotThrow(() => assertExpertBranch(manager, sessionId, anchor));
  manager.appendCustomEntry("ffa.expert", { id: "second-reference" });
  assert.doesNotThrow(() => assertExpertBranch(manager, sessionId, anchor));
  manager.branch(root);
  manager.appendCustomEntry("other-branch", {});
  assert.throws(() => assertExpertBranch(manager, sessionId, anchor));
  assert.throws(() => assertExpertBranch(SessionManager.inMemory(), sessionId, null));
});

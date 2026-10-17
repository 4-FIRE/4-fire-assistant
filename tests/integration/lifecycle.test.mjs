import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Store } from "../../dist/storage/store.js";
import { assertAgentBranch } from "../../dist/integrations/pi/agent-context.js";

const cli = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "printf", operations: [
  { name: "echo", description: "Read JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
] };

test("old tool references cannot access a reopened workspace instance", async t => {
  const { session } = await host(t, "ready", [cli]);
  const old = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const oldRead = session.agent.state.tools.find(tool => tool.name === "ffa_provider_record");
  const oldManage = session.agent.state.tools.find(tool => tool.name === "ffa_provider_manage");
  const first = await old.execute("first", { provider: "local", operation: "echo", parameters: { n: 1 } });
  assert.equal(first.structuredContent.success, true);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await assert.rejects(old.execute("closed", { provider: "local", operation: "echo", parameters: {} }));
  await session.extensionRunner.emit({ type: "session_start" });
  await assert.rejects(old.execute("reopened", { provider: "local", operation: "echo", parameters: {} }));
  await assert.rejects(oldRead.execute("reopened", { kind: "intent", id: first.structuredContent.intentId }));
  await assert.rejects(oldManage.execute("reopened", { action: "read", provider: "local", target: "connection" }));
  const fresh = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const next = await fresh.execute("fresh", { provider: "local", operation: "echo", parameters: { n: 2 } });
  assert.equal(next.structuredContent.success, true);
  assert.deepEqual(next.structuredContent.data, { n: 2 });
  assert.notEqual(next.structuredContent.intentId, first.structuredContent.intentId);
});

test("workspace shutdown waits for a cancelled external call to save its unknown result", { timeout: 15_000 }, async t => {
  const code = "import json,sys,time\nfrom pathlib import Path\np=json.load(sys.stdin)\nPath(p['file']).write_text('sent')\ntime.sleep(60)";
  const provider = { id: "local", kind: "cli", command: "python3", coverage: { basis: "Local file calculation", limitations: [] },
    operations: [{ name: "write", description: "Write local marker and wait", inputSchema: { type: "object" }, argv: ["-c", code], stdin: true }] };
  const { root, session } = await host(t, "ready", [provider], { default: "allow", tools: {} });
  let shutdown;
  const watcher = watch(root, (_event, path) => {
    if (path === "marker") shutdown ??= session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  });
  t.after(() => watcher.close());
  const call = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const result = await call.execute("write", { provider: "local", operation: "write", parameters: { file: join(root, "marker") } });
  await shutdown;
  assert.equal(result.structuredContent.state, "unknown");
  assert.equal(await readFile(join(root, "marker"), "utf8"), "sent");
  assert.deepEqual(await readdir(join(root, ".ffa/calls")), []);
  const reopened = new Store(join(root, ".ffa"), false);
  try {
    const { intent } = reopened.calls.get(result.structuredContent.intentId);
    assert.equal(intent.state, "unknown"); assert.ok(intent.attempt);
  } finally { reopened.close(); }
  await assert.rejects(call.execute("closed", { provider: "local", operation: "write", parameters: {} }));
});

test("only process quit archives calls; reload and session replacements leave loose history available", async t => {
  const { root, session, errors } = await host(t, "ready", [cli]);
  const tool = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const { structuredContent: result } = await tool.execute("first", { provider: "local", operation: "echo", parameters: { n: 42 } });
  const files = await readdir(join(root, ".ffa/calls"));
  for (const reason of ["reload", "new", "resume", "fork"]) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason });
    assert.deepEqual(await readdir(join(root, ".ffa/calls")), files);
    await assert.rejects(readdir(join(root, ".ffa/archives")), { code: "ENOENT" });
    await session.extensionRunner.emit({ type: "session_start" });
  }
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(await readdir(join(root, ".ffa/calls")), []);
  await assert.rejects(readFile(result.dataPath), { code: "ENOENT" });
  await session.extensionRunner.emit({ type: "session_start" });
  const reader = session.agent.state.tools.find(tool => tool.name === "ffa_provider_record");
  const receipt = await reader.execute("read", { kind: "receipt", id: result.receiptId });
  assert.deepEqual(JSON.parse(await readFile(receipt.structuredContent.record.dataPath, "utf8")).data, { n: 42 });
  assert.deepEqual(errors, []);
});

test("quit reports archive failures, leaves originals intact and releases ownership", async t => {
  if (process.getuid?.() === 0) return t.skip("Requires OS permission enforcement");
  const { root, session, errors } = await host(t, "ready", [cli]);
  const tool = session.agent.state.tools.find(tool => tool.name === "ffa_provider_call");
  const { structuredContent: result } = await tool.execute("first", { provider: "local", operation: "echo", parameters: { n: 42 } });
  await mkdir(join(root, ".ffa/archives"));
  await chmod(join(root, ".ffa/archives"), 0o500);
  try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
  finally { await chmod(join(root, ".ffa/archives"), 0o700); }
  assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(await readFile(result.dataPath, "utf8")).data, { n: 42 });
  const reopened = new Store(join(root, ".ffa"), false);
  try { assert.equal(reopened.calls.get(result.intentId).intent.state, "observed"); }
  finally { reopened.close(); }
});

test("agent branch checks permit normal appends but reject navigation away from the dispatching ancestor", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendCustomEntry("local-root", {});
  const anchor = manager.appendCustomEntry("local-dispatch", {}), sessionId = manager.getSessionId();
  manager.appendCustomEntry("local-progress", {});
  assert.doesNotThrow(() => assertAgentBranch(manager, sessionId, anchor));
  manager.appendCustomEntry("local-progress", {});
  assert.doesNotThrow(() => assertAgentBranch(manager, sessionId, anchor));
  manager.branch(root);
  manager.appendCustomEntry("other-branch", {});
  assert.throws(() => assertAgentBranch(manager, sessionId, anchor));
  assert.throws(() => assertAgentBranch(SessionManager.inMemory(), sessionId, null));
});

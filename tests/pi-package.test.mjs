import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { begin, finish } from "../dist/workspace.js";
import { Store } from "../dist/storage.js";
import { expertLoader } from "../dist/experts.js";
import { parseSource } from "../dist/sources.js";

async function host(t, status, sources = []) {
  const temp = await mkdtemp(join(tmpdir(), "ffa-pi-")), root = join(temp, "workspace"), agentDir = join(temp, "agent");
  await mkdir(root); await mkdir(agentDir);
  if (status) {
    await begin(root);
    const store = new Store(join(root, ".ffa"));
    for (const source of sources) store.put("source", source.id, parseSource(source));
    store.close();
    if (status === "ready") await finish(root, "test-market");
  }
  const settingsManager = SettingsManager.inMemory({ packages: [resolve(".")] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: runtime, sessionManager: SessionManager.inMemory(root) });
  const errors = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); session.dispose();
    await rm(temp, { recursive: true, force: true });
  });
  assert.deepEqual(errors, []);
  return { root, loader, session, errors };
}
for (const status of [undefined, "pending"]) {
  test("real Pi package stays inactive in " + (status ?? "new") + " workspaces", async t => {
    const { root, loader, session, errors } = await host(t, status);
    assert.equal(session.getAllTools().filter(tool => tool.name.startsWith("ffa_")).length, 0);
    assert.equal(loader.getSkills().skills.length, 0);
    assert.deepEqual(await readdir(root), status ? [".ffa"] : []);
    await session.prompt("/ffa init");
    assert.equal(errors.length, 1);
    assert.equal((await readdir(root)).length, status ? 1 : 0);
  });
}
test("ready package dynamically loads skills and tools, while confirmations fail closed without UI", async t => {
  const { root, loader, session } = await host(t, "ready");
  const names = session.getAllTools().map(tool => tool.name);
  assert.ok(names.includes("ffa_python")); assert.ok(names.includes("ffa_delegate"));
  assert.ok(!names.includes("ffa_finish_initialization"));
  assert.ok(loader.getSkills().skills.length >= 6);
  const storeFiles = await readdir(join(root, ".ffa"));
  assert.ok(storeFiles.includes("business.sqlite"));
  const configure = session.agent.state.tools.find(tool => tool.name === "ffa_configure_source");
  assert.ok(configure);
  await assert.rejects(configure.execute("test", { source: { id: "local", kind: "cli", command: "/usr/bin/printf",
    operations: [{ name: "read", description: "Print", access: "read", inputSchema: { type: "object" }, argv: ["%s", { json: true }] }] } }, undefined));
});
test("real Pi tools save CLI evidence and cannot execute unreviewed operations", async t => {
  const source = { id: "local", kind: "cli", command: "/usr/bin/printf", operations: [
    { name: "echo", description: "Return explicit JSON", access: "read", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
    { name: "write", description: "Requires approval", access: "write", inputSchema: { type: "object" }, argv: ["%s", { json: true }],
      outcomes: { accepted: { const: true }, rejected: { const: false } } }
  ] };
  const { session } = await host(t, "ready", [source]);
  const tool = name => session.agent.state.tools.find(tool => tool.name === name);
  const read = await tool("ffa_source_read").execute("read", { source: "local", operation: "echo", parameters: { sample: 42 } }, undefined);
  assert.equal(read.details.success, true);
  assert.deepEqual(read.details.data, { sample: 42 });
  const saved = await tool("ffa_record").execute("record", { kind: "receipt", id: read.details.id }, undefined);
  assert.deepEqual(JSON.parse(saved.details.text).parameters, { sample: 42 });
  await assert.rejects(tool("ffa_source_read").execute("bad", { source: "local", operation: "write", parameters: {} }, undefined));
  const prepared = await tool("ffa_prepare_trade").execute("prepare", { objective: "check approval", source: "local", operation: "write", parameters: {} }, undefined);
  assert.equal(prepared.details.state, "prepared");
  await assert.rejects(tool("ffa_execute_trade").execute("execute", { intentId: prepared.details.id }, undefined));
  const still = await tool("ffa_record").execute("record", { kind: "intent", id: prepared.details.id }, undefined);
  assert.equal(JSON.parse(still.details.text).attempt, undefined);
  const blocked = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "raw", toolName: "mcp__alias__write", input: {} });
  assert.equal(blocked?.block, true);
});
test("expert resource loader excludes project extensions and exposes only role resources", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-expert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi/extensions"), { recursive: true });
  await writeFile(join(root, ".pi/extensions/unwanted.ts"), "throw new Error('must not load');");
  const loader = await expertLoader(root, "reviewer");
  assert.equal(loader.getExtensions().extensions.length, 0);
  assert.ok(loader.getSkills().skills.length >= 6);
});

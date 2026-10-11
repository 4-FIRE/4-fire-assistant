import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { begin, finish } from "../dist/workspace.js";
import { Store } from "../dist/storage.js";
import { expertLoader } from "../dist/experts.js";
import { parseSource } from "../dist/sources.js";
import { schema } from "../dist/values.js";

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
  const settingsManager = SettingsManager.inMemory({ packages: [resolve(".")], defaultTools: ["+codemode"] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ models: false })] });
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

const localSource = { id: "local", kind: "cli", command: "/usr/bin/printf", operations: [
  { name: "echo", description: "Return JSON", access: "read", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
  { name: "write", description: "Requires approval", access: "write", inputSchema: { type: "object" }, argv: ["%s", { json: true }],
    outcomes: { accepted: { const: true }, rejected: { const: false } } }
] };
async function runScript(session, id, code, signal) {
  // Restore a local session call record. No model produces or executes this fixture.
  const model = session.model;
  assert.ok(model);
  session.sessionManager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }], stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  return session.agent.state.tools.find(tool => tool.name === "codemode").execute(id, { code }, signal);
}
function scriptValue(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content.slice(1).map(part => part.text).join(""));
}

test("real codemode discovers all active FFA tools and receives structured results", async t => {
  const { session } = await host(t, "ready", [localSource]);
  const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
  assert.ok(codemode);
  const result = await runScript(session, "discover", `
    const names = ALL_TOOLS.filter(tool => tool.name.startsWith("ffa_")).map(tool => tool.name).sort();
    const namespace = await describeNamespace("ffa");
    const description = await describeTool("ffa_source_read");
    const catalog = await tools.ffa_sources({});
    const receipt = await tools.ffa_source_read({ source: "local", operation: "echo", parameters: { sample: 42 } });
    const record = await tools.ffa_record({ kind: "receipt", id: receipt.id });
    const status = await tools.ffa_status({});
    return { names, namespace: namespace.name, described: description !== undefined,
      catalogType: typeof catalog, source: catalog.sources[0].id, data: receipt.data,
      saved: JSON.parse(record.text).parameters, state: status.workspace.status };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.names, session.getCallableToolNames().filter(name => name.startsWith("ffa_")).sort());
  for (const name of ["ffa_configure_source", "ffa_delegate", "ffa_execute_trade"]) assert.ok(data.names.includes(name));
  assert.equal(data.namespace, "ffa"); assert.equal(data.described, true);
  assert.equal(data.catalogType, "object"); assert.equal(data.source, "local");
  assert.deepEqual(data.data, { sample: 42 }); assert.deepEqual(data.saved, { sample: 42 });
  assert.equal(data.state, "ready");
  assert.ok(result.details.calls.every(call => call.status === "ok"));
});

test("codemode cannot bypass confirmation or review and retains structured failure data", async t => {
  const { session, root } = await host(t, "ready", [localSource]);
  const result = await runScript(session, "gates", `
    const prepared = await tools.ffa_prepare_trade({ objective: "check review", source: "local", operation: "write", parameters: {} });
    const calls = await Promise.allSettled([
      tools.ffa_execute_trade({ intentId: prepared.id }),
      tools.ffa_configure_source({ source: ${JSON.stringify({ ...localSource, id: "other" })} })
    ]);
    const failed = await tools.ffa_python({ code: "raise ValueError('local test')" });
    const catalog = await tools.ffa_sources({});
    const record = await tools.ffa_record({ kind: "intent", id: prepared.id });
    return { calls: calls.map(call => call.status), failed, sources: catalog.sources.map(source => source.id), intent: JSON.parse(record.text) };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.calls, ["rejected", "rejected"]);
  assert.deepEqual(data.sources, ["local"]);
  assert.equal(data.intent.state, "prepared"); assert.equal(data.intent.attempt, undefined);
  assert.equal(data.failed.state, "failed"); assert.equal(typeof data.failed.output, "object");
  assert.ok((await readdir(join(root, data.failed.path))).includes("manifest.json"));
  assert.equal(result.details.calls.filter(call => call.status === "error").length, 3);
});

test("FFA successful and failed outputs match their declared schemas", async t => {
  const { session } = await host(t, "ready", [localSource]);
  const execute = async (name, args, signal) => {
    const tool = session.agent.state.tools.find(tool => tool.name === name);
    const result = await tool.execute(name, args, signal);
    assert.ok(tool.outputSchema);
    assert.ok(schema(tool.outputSchema)(result.structuredContent), JSON.stringify(result.structuredContent));
    assert.deepEqual(result.structuredContent, result.details);
    return result;
  };
  await execute("ffa_status", {});
  await execute("ffa_sources", {});
  const single = await execute("ffa_sources", { source: "local", operation: "echo" });
  assert.equal(single.structuredContent.sources[0].operations.length, 1);
  const receipt = await execute("ffa_source_read", { source: "local", operation: "echo", parameters: { value: 1 } });
  await execute("ffa_record", { kind: "receipt", id: receipt.structuredContent.id });
  await execute("ffa_prepare_trade", { objective: "schema", source: "local", operation: "write", parameters: {} });
  await execute("ffa_python", { code: "print('42')" });
  const failed = await execute("ffa_python", { code: "raise ValueError('local test')" });
  assert.equal(failed.isError, true);
  for (const tool of session.agent.state.tools.filter(tool => tool.name.startsWith("ffa_"))) assert.ok(tool.outputSchema);
});

test("codemode removes disabled workspace tools from discovery", async t => {
  const { session } = await host(t, "ready");
  const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  const result = await codemode.execute("disabled", { code: `return ALL_TOOLS.filter(tool => tool.name.startsWith("ffa_")).map(tool => tool.name);` }, undefined);
  assert.deepEqual(scriptValue(result), []);
});

test("cancelling real codemode stops a running Python tool and saves its cancelled state", { timeout: 15_000 }, async t => {
  const { session, root } = await host(t, "ready");
  const controller = new AbortController();
  const watcher = watch(root, { recursive: true }, (_event, path) => {
    if (path?.endsWith("/ready")) controller.abort();
  });
  t.after(() => watcher.close());
  const code = "from pathlib import Path\nimport time\nPath('ready').write_text('ready')\ntime.sleep(60)";
  const result = await runScript(session, "cancel", `await tools.ffa_python({ code: ${JSON.stringify(code)} });`, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.isError, true);
  assert.equal(result.details.calls[0].status, "cancelled");
  const runs = join(root, "scratch/runs");
  const directories = await readdir(runs);
  assert.equal(directories.length, 1);
  const manifestPath = join(runs, directories[0], "manifest.json");
  // The sandbox can stop before the process tool finishes its final file writes.
  let manifest;
  for (let attempt = 0; attempt < 100; attempt++) {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.state !== "running") break;
    await delay(10);
  }
  assert.equal(manifest.state, "cancelled");
});

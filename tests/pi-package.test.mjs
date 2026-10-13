import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { host } from "./helpers/pi-host.mjs";
import { agentLoader } from "../dist/integrations/agent-resources.js";
import { schema } from "../dist/common/validation.js";

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
  assert.ok(names.includes("ffa_python")); assert.ok(names.includes("ffa_agent"));
  assert.ok(!names.includes("ffa_finish_initialization"));
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), ["provider-calls", "provider-connections", "trading"]);
  const storeFiles = await readdir(join(root, ".ffa"));
  assert.ok(storeFiles.includes("business.sqlite"));
  const configure = session.agent.state.tools.find(tool => tool.name === "ffa_configure_provider");
  assert.ok(configure);
  await assert.rejects(configure.execute("test", { provider: { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf",
    operations: [{ name: "read", description: "Print", inputSchema: { type: "object" }, argv: ["%s", { json: true }] }] } }, undefined));
});
test("real Pi tools save CLI evidence, read records and leave official MCP calls outside ffa", async t => {
  const provider = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf", operations: [
    { name: "echo", description: "Return explicit JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
    { name: "write", description: "Requires approval", inputSchema: { type: "object" }, argv: ["%s", { json: true }],
      outcomes: { accepted: { const: true }, rejected: { const: false } } }
  ] };
  const { session } = await host(t, "ready", [provider]);
  const tool = name => session.agent.state.tools.find(tool => tool.name === name);
  const read = await tool("ffa_provider_call").execute("read", { provider: "local", operation: "echo", parameters: { sample: 42 } }, undefined);
  assert.equal(read.details.success, true);
  assert.deepEqual(read.details.data, { sample: 42 });
  const saved = await tool("ffa_provider_call").execute("record", { record: { kind: "receipt", id: read.details.receiptId } }, undefined);
  assert.deepEqual(JSON.parse(saved.details.text).parameters, { sample: 42 });
  await assert.rejects(tool("ffa_provider_call").execute("bad", { provider: "local", operation: "write", parameters: {} }, undefined));
  const still = await tool("ffa_provider_call").execute("record", { record: { kind: "intent", id: read.details.intentId } }, undefined);
  assert.ok(JSON.parse(still.details.text).attempt);
  const blocked = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "raw", toolName: "mcp__ffa_local__write", input: {} });
  assert.equal(blocked, undefined);
  assert.equal(await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "other", toolName: "mcp__alias__write", input: {} }), undefined);
});
test("agent resources exclude arbitrary extensions and preserve workspace skill overrides", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi/extensions"), { recursive: true });
  await writeFile(join(root, ".pi/extensions/unwanted.ts"), "throw new Error('must not load');");
  const loader = await agentLoader(root, "reviewer");
  assert.equal(loader.getExtensions().extensions.length, 0);
  const bundled = loader.getSkills().skills.map(skill => skill.name).sort();
  assert.deepEqual((await agentLoader(root, "researcher")).getSkills().skills.map(skill => skill.name).sort(), bundled);
  assert.deepEqual((await agentLoader(root, "general-purpose")).getSkills().skills.map(skill => skill.name).sort(), bundled);
  const local = join(root, ".agents/skills/trading");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "SKILL.md"), "---\nname: trading\ndescription: Workspace method\n---\n");
  for (const agent of ["researcher", "reviewer"]) {
    const skills = (await agentLoader(root, agent)).getSkills().skills;
    assert.equal(skills.find(skill => skill.name === "trading").filePath, join(local, "SKILL.md"));
    assert.deepEqual(skills.map(skill => skill.name).sort(), bundled);
  }
});

const localProvider = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf", operations: [
  { name: "echo", description: "Return JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
  { name: "write", description: "Requires approval", inputSchema: { type: "object" }, argv: ["%s", { json: true }],
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

test("real codemode discovers all active ffa tools and receives structured results", async t => {
  const { session } = await host(t, "ready", [localProvider]);
  const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
  assert.ok(codemode);
  const result = await runScript(session, "discover", `
    const names = ALL_TOOLS.filter(tool => tool.name.startsWith("ffa_")).map(tool => tool.name).sort();
    const namespace = await describeNamespace("ffa");
    const description = await describeTool("ffa_provider_call");
    const catalog = await tools.ffa_providers({});
    const receipt = await tools.ffa_provider_call({ provider: "local", operation: "echo", parameters: { sample: 42 } });
    const record = await tools.ffa_provider_call({ record: { kind: "receipt", id: receipt.receiptId } });
    const status = await tools.ffa_status({});
    return { names, namespace: namespace.name, described: description !== undefined,
      catalogType: typeof catalog, provider: catalog.providers[0].id, data: receipt.data,
      saved: JSON.parse(record.text).parameters, state: status.workspace.status };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.names, session.getCallableToolNames().filter(name => name.startsWith("ffa_")).sort());
  for (const name of ["ffa_configure_provider", "ffa_agent", "ffa_provider_call"]) assert.ok(data.names.includes(name));
  assert.equal(data.namespace, "ffa"); assert.equal(data.described, true);
  assert.equal(data.catalogType, "object"); assert.equal(data.provider, "local");
  assert.deepEqual(data.data, { sample: 42 }); assert.deepEqual(data.saved, { sample: 42 });
  assert.equal(data.state, "ready");
  assert.ok(result.details.calls.every(call => call.status === "ok"));
});

test("real codemode uses the single agent action contract and returns the same run through wait and read", async t => {
  const { session } = await host(t, "ready");
  const result = await runScript(session, "agent-actions", `
    const catalog = await tools.ffa_agent({ action: "list" });
    const started = await tools.ffa_agent({ action: "start", agent: "general-purpose",
      message: "Local request without authentication", mode: "background" });
    const completed = await tools.ffa_agent({ action: "wait", runId: started.runId });
    const read = await tools.ffa_agent({ action: "read", runId: started.runId, offset: 0, limit: 20 });
    return { available: catalog.agents.includes("general-purpose"),
      sameRun: started.runId === completed.runId && read.runId === completed.runId,
      mode: completed.mode, state: completed.state, report: read.report };
  `);
  assert.deepEqual(scriptValue(result), { available: true, sameRun: true, mode: "background", state: "failed", report: "" });
});

test("ordinary changes still require the real Pi confirmation channel through codemode", async t => {
  const provider = structuredClone(localProvider);
  const { session } = await host(t, "ready", [provider], { default: "ask", tools: { "local/echo": "allow", "local/write": "ask" } });
  const result = await runScript(session, "ordinary-gate", `
    const outcome = await Promise.allSettled([tools.ffa_provider_call({ provider: "local", operation: "write", parameters: {} })]);
    const catalog = await tools.ffa_providers({ provider: "local", operation: "write" });
    return { requirement: catalog.providers[0].operations[0].permission, status: outcome[0].status };
  `);
  const data = scriptValue(result);
  assert.equal(data.requirement, "ask");
  assert.equal(data.status, "rejected");
});

test("codemode cannot bypass confirmation and retains structured failure data", async t => {
  const { session, root } = await host(t, "ready", [localProvider]);
  const result = await runScript(session, "gates", `
    const calls = await Promise.allSettled([
      tools.ffa_provider_call({ provider: "local", operation: "write", parameters: {} }),
      tools.ffa_configure_provider({ provider: ${JSON.stringify({ ...localProvider, id: "other" })} })
    ]);
    const failed = await tools.ffa_python({ code: "raise ValueError('local test')" });
    const catalog = await tools.ffa_providers({});
    return { calls: calls.map(call => call.status), failed, providers: catalog.providers.map(provider => provider.id) };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.calls, ["rejected", "rejected"]);
  assert.deepEqual(data.providers, ["local"]);
  assert.equal(data.failed.state, "failed"); assert.equal(typeof data.failed.output, "object");
  assert.ok((await readdir(join(root, data.failed.path))).includes("manifest.json"));
  assert.equal(result.details.calls.filter(call => call.status === "error").length, 3);
});

test("file tools cannot edit program-owned permissions and manual user maintenance remains effective", async t => {
  const { root, session } = await host(t, "ready", [localProvider]);
  const before = await readFile(join(root, ".ffa/permissions.json"), "utf8");
  for (const toolName of ["write", "edit"]) {
    const decision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: toolName, toolName,
      input: { path: ".ffa/permissions.json" } });
    assert.equal(decision?.block, true);
  }
  const result = await runScript(session, "permissions-edit", `
    const callable = ALL_TOOLS.some(tool => tool.name === "write");
    const outcome = await Promise.allSettled([tools.write({ path: ".ffa/permissions.json", content: '{"default":"allow","tools":{}}' })]);
    return { callable, status: outcome[0].status };
  `);
  const data = scriptValue(result);
  assert.equal(data.callable, true); assert.equal(data.status, "rejected");
  assert.equal(result.details.calls.length, 1); assert.equal(result.details.calls[0].status, "error");
  assert.equal(await readFile(join(root, ".ffa/permissions.json"), "utf8"), before);
  await writeFile(join(root, ".ffa/permissions.json"), JSON.stringify({ default: "deny", tools: {} }));
  const catalog = await session.agent.state.tools.find(tool => tool.name === "ffa_providers").execute("permissions", {});
  assert.ok(catalog.structuredContent.providers[0].operations.every(op => op.permission === "deny"));
  await assert.rejects(session.agent.state.tools.find(tool => tool.name === "ffa_provider_call").execute("denied", {
    provider: "local", operation: "echo", parameters: {},
  }));
});

test("ffa successful and failed outputs match their declared schemas", async t => {
  const { session } = await host(t, "ready", [localProvider]);
  const execute = async (name, args, signal) => {
    const tool = session.agent.state.tools.find(tool => tool.name === name);
    const result = await tool.execute(name, args, signal);
    assert.ok(tool.outputSchema);
    assert.ok(schema(tool.outputSchema)(result.structuredContent), JSON.stringify(result.structuredContent));
    assert.deepEqual(result.structuredContent, result.details);
    return result;
  };
  await execute("ffa_status", {});
  await execute("ffa_providers", {});
  const single = await execute("ffa_providers", { provider: "local", operation: "echo" });
  assert.equal(single.structuredContent.providers[0].operations.length, 1);
  const receipt = await execute("ffa_provider_call", { provider: "local", operation: "echo", parameters: { value: 1 } });
  await execute("ffa_provider_call", { record: { kind: "receipt", id: receipt.structuredContent.receiptId } });
  await execute("ffa_python", { code: "print('42')" });
  const failed = await execute("ffa_python", { code: "raise ValueError('local test')" });
  assert.equal(failed.isError, true);
  for (const tool of session.agent.state.tools.filter(tool => tool.name.startsWith("ffa_"))) assert.ok(tool.outputSchema);
});

test("one call tool returns large previews, reads all pages and rejects mixed inputs", async t => {
  const { session } = await host(t, "ready", [localProvider]);
  const result = await runScript(session, "large-record", `
    const payload = "x".repeat(30000);
    const call = await tools.ffa_provider_call({ provider: "local", operation: "echo", parameters: { payload } });
    let offset = 0, text = "", pages = 0;
    do {
      const page = await tools.ffa_provider_call({ record: { kind: "receipt", id: call.receiptId, offset, limit: 4000 } });
      text += page.text; offset = page.nextOffset; pages++;
    } while (offset !== null);
    const rejected = await Promise.allSettled([
      tools.ffa_provider_call({ provider: "local", operation: "echo", parameters: {}, record: { kind: "receipt", id: call.receiptId } }),
      tools.ffa_provider_call({ record: { kind: "receipt", id: call.receiptId, offset: text.length + 1 } }),
      tools.ffa_provider_call({ record: { kind: "setting", id: "python" } })
    ]);
    return { success: call.success, truncated: call.truncated, previewLength: call.data.preview.length,
      restored: JSON.parse(text).data.payload === payload, pages, rejected: rejected.map(value => value.status) };
  `);
  const data = scriptValue(result);
  assert.equal(data.success, true); assert.equal(data.truncated, true);
  assert.equal(data.previewLength, 16000); assert.equal(data.restored, true);
  assert.ok(data.pages > 1); assert.deepEqual(data.rejected, ["rejected", "rejected", "rejected"]);
});

test("unknown call results retain their IDs and data through real codemode", async t => {
  const { session } = await host(t, "ready", [localProvider], { default: "ask", tools: { "local/write": "allow" } });
  const result = await runScript(session, "unknown", `
    const call = await tools.ffa_provider_call({ provider: "local", operation: "write", parameters: { sample: 42 } });
    const intent = await tools.ffa_provider_call({ record: { kind: "intent", id: call.intentId } });
    const receipt = await tools.ffa_provider_call({ record: { kind: "receipt", id: call.receiptId } });
    return { call, intent: JSON.parse(intent.text), receipt: JSON.parse(receipt.text) };
  `);
  const data = scriptValue(result);
  assert.equal(data.call.state, "unknown"); assert.equal(data.call.success, false);
  assert.equal(data.intent.receiptId, data.call.receiptId); assert.ok(data.intent.attempt);
  assert.deepEqual(data.receipt.data, { sample: 42 }); assert.equal(data.receipt.success, false);
  assert.equal(result.details.calls[0].status, "error");
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

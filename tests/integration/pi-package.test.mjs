import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { agentLoader } from "../../dist/integrations/pi/agent-resources.js";
import { schema } from "../../dist/common/validation.js";
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

for (const status of [undefined, "pending"]) {
  test("real Pi package stays inactive in " + (status ?? "new") + " workspaces", async t => {
    const { root, loader, session, errors } = await host(t, status);
    assert.equal(session.getAllTools().filter(tool => tool.name.startsWith("ffa_")).length, 0);
    assert.equal(loader.getSkills().skills.length, 0);
    assert.deepEqual(await readdir(root), status ? [".ffa"] : []);
    const started = await session.extensionRunner.emitBeforeAgentStart("", undefined, { cwd: root });
    assert.doesNotThrow(() => buildSystemPrompt(started.systemPromptOptions));
    assert.equal(Object.hasOwn(started.systemPromptOptions.sections, "ffa_workspace"), false);
    assert.equal(Object.hasOwn(started.systemPromptOptions.sections, "ffa"), false);
    assert.deepEqual(errors, []);
    await session.prompt("/ffa init");
    assert.equal(errors.length, 1);
    assert.equal((await readdir(root)).length, status ? 1 : 0);
  });
}
test("native autocomplete lists ffa subcommands, filters prefixes and does not complete arguments", async t => {
  const { root, session } = await host(t);
  const command = session.extensionRunner.getRegisteredCommands().find(command => command.name === "ffa");
  assert.ok(command);
  const autocomplete = new CombinedAutocompleteProvider([command], root);
  const suggest = text => autocomplete.getSuggestions([text], 0, text.length, { force: false });
  const all = await suggest("/ffa ");
  assert.equal(all.prefix, "");
  assert.deepEqual(all.items.map(item => item.value), ["init", "status", "agents", "python"]);
  const filtered = await suggest("/ffa st");
  assert.deepEqual(filtered.items.map(item => item.value), ["status"]);
  const completed = autocomplete.applyCompletion(["/ffa st"], 0, 7, filtered.items[0], filtered.prefix);
  assert.equal(completed.lines[0].trimEnd(), "/ffa status");
  for (const text of ["/ffa unknown", "/ffa resolve ", "/ffa python /", "/ffa init "]) {
    assert.equal(await suggest(text), null);
  }
});

test("ready package dynamically loads skills and tools, while confirmations fail closed without UI", async t => {
  const { root, loader, session, errors } = await host(t, "ready");
  const started = await session.extensionRunner.emitBeforeAgentStart("", undefined, { cwd: root });
  assert.doesNotThrow(() => buildSystemPrompt(started.systemPromptOptions));
  assert.equal(Object.hasOwn(started.systemPromptOptions.sections, "ffa_workspace"), true);
  assert.equal(Object.hasOwn(started.systemPromptOptions.sections, "ffa"), true);
  assert.deepEqual(errors, []);
  const names = session.getAllTools().map(tool => tool.name);
  assert.deepEqual(names.filter(name => name.startsWith("ffa_")).sort(), [
    "ffa_agent", "ffa_provider_call", "ffa_provider_manage", "ffa_provider_record", "ffa_providers", "ffa_status",
  ]);
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), ["project-maintenance", "provider-calls", "provider-connections", "trading"]);
  const storeFiles = await readdir(join(root, ".ffa"));
  assert.deepEqual(storeFiles.sort(), ["calls", "permissions.json", "providers", "results", "settings.json", "workspace.json"]);
  const configure = session.agent.state.tools.find(tool => tool.name === "ffa_provider_manage");
  assert.ok(configure);
  await assert.rejects(configure.execute("test", { action: "register", provider: "local", config: { kind: "cli", command: "printf" },
    coverage: { basis: "printf(1)", limitations: [] }, operations: [{ name: "read", description: "Print", inputSchema: { type: "object" }, argv: ["%s", { json: true }] }] }, undefined));
});
test("real Pi tools save CLI evidence, read records and leave official MCP calls outside ffa", async t => {
  const provider = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "printf", operations: [
    { name: "echo", description: "Return explicit JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
    { name: "write", description: "Requires approval", inputSchema: { type: "object" }, argv: ["%s", { json: true }],
      outcomes: { accepted: { const: true }, rejected: { const: false } } }
  ] };
  const { session } = await host(t, "ready", [provider]);
  const tool = name => session.agent.state.tools.find(tool => tool.name === name);
  const read = await tool("ffa_provider_call").execute("read", { provider: "local", operation: "echo", parameters: { sample: 42 } }, undefined);
  assert.equal(read.details.success, true);
  assert.deepEqual(read.details.data, { sample: 42 });
  const saved = await tool("ffa_provider_record").execute("record", { kind: "receipt", id: read.details.receiptId }, undefined);
  assert.deepEqual(saved.details.record.parameters, { sample: 42 });
  await assert.rejects(tool("ffa_provider_call").execute("bad", { provider: "local", operation: "write", parameters: {} }, undefined));
  const still = await tool("ffa_provider_record").execute("record", { kind: "intent", id: read.details.intentId }, undefined);
  assert.ok(still.details.record.attempt);
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

const localProvider = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "printf", operations: [
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
    const record = await tools.ffa_provider_record({ kind: "receipt", id: receipt.receiptId });
    const status = await tools.ffa_status({});
    return { names, namespace: namespace.name, described: description !== undefined,
      catalogType: typeof catalog, provider: catalog.providers[0].id, data: receipt.data,
      saved: record.record.parameters, state: status.workspace.status };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.names, session.getCallableToolNames().filter(name => name.startsWith("ffa_")).sort());
  for (const name of ["ffa_provider_manage", "ffa_agent", "ffa_provider_call"]) assert.ok(data.names.includes(name));
  assert.equal(data.namespace, "ffa"); assert.equal(data.described, true);
  assert.equal(data.catalogType, "object"); assert.equal(data.provider, "local");
  assert.deepEqual(data.data, { sample: 42 }); assert.deepEqual(data.saved, { sample: 42 });
  assert.equal(data.state, "ready");
  assert.ok(result.details.calls.every(call => call.status === "ok"));
});

test("real codemode reads editable provider objects and rejects invalid mutations without writes", async t => {
  const { session } = await host(t, "ready", [localProvider]);
  const result = await runScript(session, "manage-contract", `
    const connection = await tools.ffa_provider_manage({ action: "read", provider: "local", target: "connection" });
    const operations = await tools.ffa_provider_manage({ action: "read", provider: "local", target: "operations" });
    const permissions = await tools.ffa_provider_manage({ action: "read", provider: "local", target: "permissions" });
    const rejected = await Promise.allSettled([
      tools.ffa_provider_manage({ action: "register", provider: "other", config: { kind: "cli", command: "cat", discovery: {} }, coverage: { basis: "cat", limitations: [] }, operations: [] }),
      tools.ffa_provider_manage({ action: "discover", provider: "local" }),
      tools.ffa_provider_manage({ action: "read", provider: "local", target: "connection", permissions: {} })
    ]);
    const conflict = await tools.ffa_provider_manage({ action: "update", provider: "local", target: "connection", config: connection.config, expectedRevision: "expired" });
    return { connection, operations, permissions, rejected: rejected.map(v => v.status), conflict };
  `);
  const data = scriptValue(result);
  assert.equal(data.connection.config.operations, undefined);
  assert.equal(data.operations.operations[0].definition.id, undefined);
  assert.equal(data.operations.operations[0].definition.permission, undefined);
  assert.equal(data.conflict.error.category, "conflict");
  assert.deepEqual(data.rejected, ["rejected", "rejected", "rejected"]);
  assert.equal(typeof data.permissions.revision, "string");
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

test("codemode cannot bypass confirmation for calls or provider registration", async t => {
  const { session } = await host(t, "ready", [localProvider]);
  const result = await runScript(session, "gates", `
    const calls = await Promise.allSettled([
      tools.ffa_provider_call({ provider: "local", operation: "write", parameters: {} }),
      tools.ffa_provider_manage(${JSON.stringify({ action: "register", provider: "other", config: { kind: "cli", command: localProvider.command }, coverage: localProvider.coverage, operations: localProvider.operations })})
    ]);
    const catalog = await tools.ffa_providers({});
    return { calls: calls.map(call => call.status), providers: catalog.providers.map(provider => provider.id) };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.calls, ["rejected", "rejected"]);
  assert.deepEqual(data.providers, ["local"]);
  assert.equal(result.details.calls.filter(call => call.status === "error").length, 2);
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
  const summary = await execute("ffa_providers", {});
  assert.equal(summary.structuredContent.providers[0].operations[0].inputSchema, undefined);
  for (const target of ["connection", "operations", "coverage", "permissions", "outcomes"]) {
    await execute("ffa_provider_manage", { action: "read", provider: "local", target, ...(target === "outcomes" ? { operation: "echo" } : {}) });
  }
  const single = await execute("ffa_providers", { provider: "local", operation: "echo" });
  assert.equal(single.structuredContent.providers[0].operations.length, 1);
  assert.deepEqual(single.structuredContent.providers[0].operations[0].inputSchema, { type: "object" });
  const receipt = await execute("ffa_provider_call", { provider: "local", operation: "echo", parameters: { value: 1 } });
  await execute("ffa_provider_record", { kind: "receipt", id: receipt.structuredContent.receiptId });
  const connection = await execute("ffa_provider_manage", { action: "read", provider: "local", target: "connection" });
  const failed = await execute("ffa_provider_manage", { action: "update", provider: "local", target: "connection",
    config: connection.structuredContent.config, expectedRevision: "expired" });
  assert.equal(failed.isError, true);
  for (const tool of session.agent.state.tools.filter(tool => tool.name.startsWith("ffa_"))) assert.ok(tool.outputSchema);
});

test("large call results have a native-readable file and record lookup returns only metadata", async t => {
  const { session } = await host(t, "ready", [localProvider]);
  const result = await runScript(session, "large-record", `
    const payload = "x".repeat(30000);
    const call = await tools.ffa_provider_call({ provider: "local", operation: "echo", parameters: { payload } });
    const receipt = await tools.ffa_provider_record({ kind: "receipt", id: call.receiptId });
    const rejected = await Promise.allSettled([
      tools.ffa_provider_call({ provider: "local", operation: "echo", parameters: {}, record: { kind: "receipt", id: call.receiptId } }),
      tools.ffa_provider_record({ kind: "receipt", id: call.receiptId, offset: 0 }),
      tools.ffa_provider_record({ kind: "setting", id: "python" })
    ]);
    return { success: call.success, truncated: call.truncated, previewLength: call.data.preview.length,
      dataPath: call.dataPath, receiptPath: receipt.record.dataPath, hasData: "data" in receipt.record,
      rejected: rejected.map(value => value.status) };
  `);
  const data = scriptValue(result);
  assert.equal(data.success, true); assert.equal(data.truncated, true);
  assert.equal(data.previewLength, 16000);
  assert.equal(data.receiptPath, data.dataPath); assert.equal(data.hasData, false);
  const read = await session.agent.state.tools.find(tool => tool.name === "read").execute("body", { path: data.dataPath });
  assert.equal(JSON.parse(read.content.find(part => part.type === "text").text).data.payload, "x".repeat(30000));
  assert.deepEqual(data.rejected, ["rejected", "rejected", "rejected"]);
});

test("unknown call results retain their IDs and data through real codemode", async t => {
  const { session } = await host(t, "ready", [localProvider], { default: "ask", tools: { "local/write": "allow" } });
  const result = await runScript(session, "unknown", `
    const call = await tools.ffa_provider_call({ provider: "local", operation: "write", parameters: { sample: 42 } });
    const intent = await tools.ffa_provider_record({ kind: "intent", id: call.intentId });
    const receipt = await tools.ffa_provider_record({ kind: "receipt", id: call.receiptId });
    return { call, intent: intent.record, receipt: receipt.record };
  `);
  const data = scriptValue(result);
  assert.equal(data.call.state, "unknown"); assert.equal(data.call.success, false);
  assert.equal(data.intent.receiptId, data.call.receiptId); assert.ok(data.intent.attempt);
  assert.deepEqual(JSON.parse(await readFile(data.receipt.dataPath, "utf8")).data, { sample: 42 }); assert.equal(data.receipt.success, false);
  assert.equal(result.details.calls[0].status, "error");
});

test("codemode removes disabled workspace tools from discovery", async t => {
  const { session } = await host(t, "ready");
  const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const result = await codemode.execute("disabled", { code: `return ALL_TOOLS.filter(tool => tool.name.startsWith("ffa_")).map(tool => tool.name);` }, undefined);
  assert.deepEqual(scriptValue(result), []);
});

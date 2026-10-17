import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access, symlink, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { agentModelRuntime } from "../../dist/integrations/pi/pi-agents.js";
import { agentLoader } from "../../dist/integrations/pi/agent-resources.js";
import { join } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { approveLocally, localConfirmation } from "../helpers/local-confirmation.mjs";
import { Store } from "../../dist/storage/store.js";
import { begin, state } from "../../dist/storage/workspace-state.js";
import { ProviderConnections } from "../../dist/integrations/providers/provider-connections.js";
import { PiAgents } from "../../dist/integrations/pi/pi-agents.js";
import { bindAgentRun } from "../../dist/extension/agent-run.js";
import { agentFileTools } from "../../dist/integrations/pi/agent-tools.js";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { agentContext } from "../../dist/integrations/pi/agent-context.js";
import { PythonEnvironmentService } from "../../dist/services/workspace/python-environment-service.js";
import { RecordService } from "../../dist/services/execution/record-service.js";
import { WorkspaceInstance } from "../../dist/extension/lifecycle.js";
import { mainTools } from "../../dist/tools/register.js";
import { ProviderRegistry } from "../../dist/services/providers/provider-registry.js";
import { parseProvider, providerData } from "../../dist/storage/provider-config.js";
import { ExecutionService } from "../../dist/services/execution/execution-service.js";
import { InitializationService, prepareWorkspace } from "../../dist/services/workspace/initialization-service.js";
import { Confirmations } from "../../dist/ui/confirmation.js";
import { Provider, Operation } from "../../dist/model/provider.js";
import { canonical, json } from "../../dist/common/json.js";

const provider = { id: "local", kind: "cli", coverage: { basis: "printf(1)", limitations: ["Only JSON output is described"] }, command: "printf", operations: [
  { name: "echo", description: "Read explicit JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
  { name: "write", description: "Print quantity", inputSchema: { type: "object", required: ["quantity"],
    properties: { quantity: { type: "integer", minimum: 1 } }, additionalProperties: false }, argv: ["%s", { json: true }] },
] };
const scope = { session: "local-session" };

async function fixture(t, withProvider = true) {
  const { root, session, api } = await host(t);
  const current = await begin(root), store = new Store(join(root, ".ffa"));
  if (withProvider) store.providers.save(provider.id, providerData(parseProvider(provider)));
  const providers = new ProviderRegistry(store, new ProviderConnections(root), root);
  const execution = new ExecutionService(providers, store);
  if (withProvider) {
    await providers.permissions.initialize();
    await writeFile(join(root, ".ffa/permissions.json"), JSON.stringify({ default: "ask", tools: { "local/echo": "allow", "local/write": "review" } }));
  }
  const confirmations = new Confirmations(), ctx = session.extensionRunner.createToolContext("local", undefined);
  const confirm = value => confirmations.ask(ctx, "Local boundary check", value);
  const initialization = new InitializationService(root, current, providers);
  const pythonEnvironment = new PythonEnvironmentService(root), records = new RecordService(store.calls), agents = new AgentService(execution);
  const instance = new WorkspaceInstance(root, store, providers, execution, initialization, pythonEnvironment, records, agents);
  const agentHost = new PiAgents();
  const bindRun = context => bindAgentRun(api, agentHost, providers, records, instance, context, confirmations);
  t.after(() => instance.close());
  return { root, session, current, store, providers, execution, confirm, ctx, confirmations, agents, instance, bindRun };
}

test("data classes serialize explicitly and caller changes do not alter a pending call", async t => {
  const f = await fixture(t);
  const parsed = parseProvider(provider);
  assert.ok(parsed instanceof Provider); assert.ok(parsed.operations[0] instanceof Operation);
  assert.throws(() => canonical(parsed));
  assert.deepEqual(json(providerData(parsed)), provider);
  const query = { value: 42 }, pending = f.execution.call(scope, "local", "echo", query, approveLocally);
  query.value = 99;
  const intent = await pending;
  assert.deepEqual(intent.data, { value: 42 });
  assert.deepEqual(intent.parameters, { value: 42 });
  const { data: _data, dataPath: _dataPath, ...metadata } = intent;
  assert.deepEqual(f.store.calls.get(intent.id)?.intent, json(metadata));
  intent.parameters.value = 99;
  assert.equal(f.execution.get(intent.id).parameters.value, 42);
  const receipt = f.store.calls.receipt(intent.receiptId);
  assert.deepEqual(receipt.parameters, { value: 42 });
  assert.equal(receipt.provider, "local");
});

test("invalid parameters and noninteractive approval reject without sending", async t => {
  const f = await fixture(t);
  assert.throws(() => f.instance.records.read("setting", "python"));
  await assert.rejects(f.execution.call(scope, "local", "write", { quantity: 1 }, f.confirm));
  await assert.rejects(f.execution.call(scope, "local", "absent", {}, f.confirm));
  await assert.rejects(f.execution.call(scope, "local", "write", { quantity: 0 }, approveLocally));
  assert.ok(f.store.calls.list().map(record => record.intent).every(intent => !intent.attempt));
  await assert.rejects(f.providers.manage({ action: "register", provider: "other", config: { kind: "cli", command: provider.command }, coverage: provider.coverage, operations: provider.operations }, f.confirm));
  assert.deepEqual(f.providers.list().map(value => value.id), ["local"]);
});

test("workspace cancellation stops current approval without cancelling a later explicit call", async t => {
  const f = await fixture(t), cancel = f.instance.signal(), confirmation = localConfirmation(cancel);
  const pending = f.execution.call(scope, "local", "write", { quantity: 1 }, confirmation.ask, cancel);
  const { value } = await confirmation.ready;
  f.instance.cancelWork();
  await assert.rejects(pending);
  assert.equal(f.execution.get(value.intentId).attempt, undefined);
  assert.equal((await f.execution.call(scope, "local", "write", { quantity: 2 }, approveLocally, f.instance.signal())).state, "observed");
});

test("initialization retains pending state and user documents when host confirmation rejects", async t => {
  const f = await fixture(t), service = new InitializationService(f.root, f.current, f.providers);
  await prepareWorkspace(f.root);
  await writeFile(join(f.root, "AGENTS.md"), "User-owned instructions");
  await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
  await mkdir(join(f.root, "providers/local"));
  await writeFile(join(f.root, "providers/local/GUIDE.md"), "Provider guide");
  await assert.rejects(service.complete({ market: "local" }, f.confirm, f.instance.signal()));
  assert.equal(service.snapshot().status, "pending");
  assert.equal((await state(f.root)).status, "pending");
  assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "User-owned instructions");
});

test("initialization accepts complete catalogs without requiring business calls", async t => {
  const f = await fixture(t);
  const configured = providerData(f.providers.provider("local"));
  configured.operations.push({ name: "undocumented", description: "", inputSchema: { type: "object" }, argv: ["%s", { json: true }] });
  f.store.providers.save("local", providerData(parseProvider(configured)));
  await prepareWorkspace(f.root);
  await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
  await mkdir(join(f.root, "providers/local"));
  await writeFile(join(f.root, "providers/local/GUIDE.md"), "Known capabilities");
  await f.instance.initialization.complete({ market: "local" }, approveLocally, f.instance.signal());
  assert.equal(f.instance.initialization.snapshot().status, "ready");
  assert.equal((await state(f.root)).market, "local");
  assert.equal(f.providers.permission("local", "undocumented"), "ask");
  assert.deepEqual(f.store.calls.list().map(record => record.intent), []);
});

test("registered providers do not require guides for initialization but missing internal permissions still fail closed", async t => {
  const f = await fixture(t), service = f.instance.initialization, signal = f.instance.signal();
  const path = join(f.root, ".ffa/permissions.json"), permissions = await readFile(path, "utf8");
  await rm(path);
  await assert.rejects(service.complete({}, approveLocally, signal));
  await assert.rejects(access(path));
  assert.equal((await state(f.root)).status, "pending");
  await writeFile(path, permissions);
  await service.complete({}, approveLocally, signal);
  assert.equal((await state(f.root)).status, "ready");
  await assert.rejects(access(join(f.root, "providers/AGENTS.md")));
  await assert.rejects(access(join(f.root, "providers/local/GUIDE.md")));
  assert.deepEqual(f.store.calls.list().map(record => record.intent), []);
});

test("failed MCP discovery does not block initialization or become verified on reopening", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false), signal = f.instance.signal();
  // The actual local process exits immediately; no MCP server is simulated.
  const configured = await f.providers.manage({ action: "register", provider: "offline", config: { kind: "mcp", command: "/usr/bin/false" } }, approveLocally, signal);
  assert.equal(configured.discovery.status, "failed");
  const before = providerData(f.providers.provider("offline"));
  await f.instance.initialization.complete({}, approveLocally, signal);
  assert.equal((await state(f.root)).status, "ready");
  assert.deepEqual(providerData(f.providers.provider("offline")), before);
  assert.deepEqual(f.store.calls.list().map(record => record.intent), []);
  assert.deepEqual(f.store.calls.list().flatMap(record => record.receipt ? [record.receipt] : []), []);
  await f.instance.close();
  await f.session.extensionRunner.emit({ type: "session_start" });
  const tools = f.session.agent.state.tools;
  const status = await tools.find(tool => tool.name === "ffa_status").execute("status", {});
  assert.equal(status.structuredContent.workspace.status, "ready");
  assert.equal(status.structuredContent.notices.length, 1);
  const catalog = await tools.find(tool => tool.name === "ffa_providers").execute("catalog", {});
  assert.equal(catalog.structuredContent.providers[0].discovery.status, "failed");
  const call = tools.find(tool => tool.name === "ffa_provider_call");
  await assert.rejects(call.execute("unavailable", { provider: "offline", operation: "absent", parameters: {} }));
});

test("workspace initializes without providers or market and native Pi enables its tools on reopening", async t => {
  const f = await fixture(t, false), service = f.instance.initialization;
  await service.complete({}, approveLocally, f.instance.signal());
  const ready = { format: "ffa/0.3", status: "ready" };
  assert.deepEqual({ ...service.snapshot() }, ready);
  assert.deepEqual({ ...await state(f.root) }, ready);
  assert.deepEqual(f.providers.list(), []);
  assert.deepEqual(f.providers.permissions.read(), { default: "ask", tools: {} });
  assert.deepEqual(f.store.calls.list().map(record => record.intent), []);
  assert.deepEqual(f.store.calls.list().flatMap(record => record.receipt ? [record.receipt] : []), []);
  await assert.rejects(access(join(f.root, "providers/AGENTS.md")));
  await f.instance.close();
  await f.session.extensionRunner.emit({ type: "session_start" });
  const tools = f.session.agent.state.tools;
  assert.ok(tools.some(tool => tool.name === "ffa_agent"));
  assert.ok(!tools.some(tool => tool.name === "ffa_python"));
  const status = tools.find(tool => tool.name === "ffa_status");
  const result = await status.execute("status", {});
  const { schema } = await import("../../dist/common/validation.js");
  assert.ok(schema(status.outputSchema)(result.structuredContent));
  assert.deepEqual(result.structuredContent.workspace, ready);
});

for (const change of ["permissions", "provider", "documents", "cancel"]) {
  test("initialization does not complete when " + change + " changes during confirmation", async t => {
    const f = await fixture(t), signal = f.instance.signal(), confirmation = localConfirmation(signal);
    await prepareWorkspace(f.root);
    await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
    await mkdir(join(f.root, "providers/local"));
    await writeFile(join(f.root, "providers/local/GUIDE.md"), "Provider guide");
    const pending = f.instance.initialization.complete({}, confirmation.ask, signal);
    const rejected = assert.rejects(pending);
    const { dialog } = await confirmation.ready;
    if (change === "permissions") await writeFile(join(f.root, ".ffa/permissions.json"), JSON.stringify({ default: "deny", tools: {} }));
    if (change === "provider") f.store.providers.save("local", { ...provider, command: "true" });
    if (change === "documents") await writeFile(join(f.root, "AGENTS.md"), "");
    if (change === "cancel") f.instance.cancelWork();
    dialog.handleInput("\r");
    await rejected;
    assert.equal(f.instance.initialization.snapshot().status, "pending");
    assert.equal((await state(f.root)).status, "pending");
    assert.deepEqual(f.store.calls.list().map(record => record.intent), []);
  });
}

test("pending workspace exposes initialization tools and structured call and read results", async t => {
  const f = await fixture(t), tools = mainTools(f.instance, f.instance, f.confirmations, f.bindRun);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "ffa_finish_initialization", "ffa_provider_call", "ffa_provider_manage", "ffa_provider_record", "ffa_providers",
  ]);
  const call = tools.find(tool => tool.name === "ffa_provider_call");
  const value = await call.execute("local", { provider: "local", operation: "echo", parameters: { n: 1 } }, undefined, undefined, f.ctx);
  const { schema } = await import("../../dist/common/validation.js");
  assert.ok(schema(call.outputSchema)(value.structuredContent));
  assert.deepEqual(value.structuredContent.data, { n: 1 });
  const reader = tools.find(tool => tool.name === "ffa_provider_record");
  const record = await reader.execute("read", { kind: "receipt", id: value.structuredContent.receiptId }, undefined, undefined, f.ctx);
  assert.ok(schema(reader.outputSchema)(record.structuredContent));
  assert.deepEqual(JSON.parse(await readFile(record.structuredContent.record.dataPath, "utf8")).data, { n: 1 });
  assert.throws(() => f.instance.check(true));
});

test("continuation selects an exact run checkpoint and keeps independent reviewer boundaries", async t => {
  const f = await fixture(t), signal = f.instance.signal();
  const manager = SessionManager.create(f.root, f.ctx.sessionManager.getSessionDir());
  const first = manager.appendMessage({ role: "user", content: "Recorded first request", timestamp: Date.now() });
  const second = manager.appendMessage({ role: "user", content: "Recorded later request", timestamp: Date.now() });
  const session = { conversationId: "recorded-conversation", agent: "researcher", file: manager.getSessionFile(), leaf: first };
  const value = { runId: "first", agent: "researcher", message: "Recorded request", mode: "foreground",
    state: "completed", createdAt: 1, finishedAt: 2, activity: "completed", report: "", session,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  f.agents.restore([value, { ...value, runId: "second", session: { ...session, leaf: second } },
    { ...value, runId: "review", agent: "reviewer", session: { ...session, agent: "reviewer" } }], new Set());
  const runIds = new Set(["first", "second", "review"]);
  assert.throws(() => f.agents.prepare({ agent: "researcher", message: "local", runId: "absent" }, runIds, scope, signal));
  assert.throws(() => f.agents.prepare({ agent: "researcher", message: "local", runId: "first" }, new Set(), scope, signal));
  assert.equal(f.agents.prepare({ agent: "researcher", message: "local", runId: "first" }, runIds, scope, signal).previous.leaf, first);
  assert.equal(f.agents.prepare({ agent: "researcher", message: "local", runId: "second" }, runIds, scope, signal).previous.leaf, second);
  assert.throws(() => f.agents.prepare({ agent: "reviewer", message: "local", runId: "first" }, runIds, scope, signal));
  assert.throws(() => f.agents.prepare({ agent: "reviewer", message: "local", runId: "review" }, runIds, scope, signal));
  const task = f.agents.prepare({ agent: "reviewer", message: "Review this plan and its quantities" }, new Set(), scope, signal);
  const intent = await task.call("local", "echo", { independent: true }, approveLocally);
  assert.equal(intent.state, "observed"); assert.deepEqual(intent.data, { independent: true });
});

test("busy continuation is rejected before queueing another request on the same conversation", async t => {
  const f = await fixture(t), signal = f.instance.signal(undefined, true);
  const manager = SessionManager.create(f.root, f.ctx.sessionManager.getSessionDir());
  const leaf = manager.appendMessage({ role: "user", content: "Recorded request", timestamp: Date.now() });
  const source = { runId: "source", agent: "researcher", message: "Recorded request", mode: "foreground",
    state: "completed", createdAt: 1, finishedAt: 2, activity: "completed", report: "",
    session: { conversationId: "recorded-conversation", agent: "researcher", file: manager.getSessionFile(), leaf },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  f.agents.restore([source], new Set());
  const runIds = new Set(["source"]), host = new PiAgents();
  const runId = f.agents.start({ agent: "researcher", message: "Local unauthenticated follow-up", runId: "source" },
    runIds, scope, (task, cancel, progress, control) =>
      host.run(f.ctx, task.agent, task.message, [], task.previous, cancel, progress, control), signal,
    value => f.ctx.sessionManager.appendCustomEntry("ffa.agent-run", value));
  runIds.add(runId);
  assert.throws(() => f.agents.prepare({ agent: "researcher", message: "New round", runId: "source" }, runIds, scope, signal));
  assert.throws(() => f.agents.prepare({ agent: "researcher", message: "New round", runId }, runIds, scope, signal));
  await assert.rejects(f.agents.steer(runId, runIds, "Too early"));
  assert.equal(f.agents.list(runIds).length, 2);
  const result = await f.agents.wait(runId, runIds, signal);
  assert.equal(result.state, "failed");
  assert.equal(result.report, "");
  assert.equal(f.agents.prepare({ agent: "researcher", message: "Explicit retry", runId }, runIds, scope, signal).previous.conversationId,
    source.session.conversationId);
});

test("agent calls use the same permission and cancellation boundary", async t => {
  const f = await fixture(t), signal = f.instance.signal();
  const task = f.agents.prepare({ agent: "reviewer", message: "Verify local numbers" }, new Set(), scope, signal);
  const intent = await task.call("local", "write", { quantity: 1 }, approveLocally);
  assert.equal(intent.permission, "review"); assert.equal(intent.state, "observed");
  await assert.rejects(task.call("local", "write", { quantity: 2 }, f.confirm));
  f.instance.cancelWork();
  await assert.rejects(async () => task.call("local", "echo", {}, approveLocally));
});

test("background calls survive foreground cancellation but stop at workspace navigation", async t => {
  const f = await fixture(t), signal = f.instance.signal(undefined, true);
  const task = f.agents.prepare({ agent: "general-purpose", message: "Local calculation" }, new Set(), scope, signal);
  f.instance.cancelWork();
  assert.equal(signal.aborted, false);
  const intent = await task.call("local", "echo", { value: 42 }, approveLocally);
  assert.equal(intent.state, "observed");
  f.instance.cancelAgents();
  await assert.rejects(async () => task.call("local", "echo", {}, approveLocally));
});

test("native agent file tools remain available while protecting internal aliases and rejecting outside writes before mkdir", async t => {
  const f = await fixture(t), cancel = f.instance.signal(undefined, true);
  const fileTools = agentFileTools(f.root, cancel, (path, change, signal) => f.instance.authorizeFile(path, change,
    value => f.confirmations.ask(f.ctx, "Outside write", value, signal), signal));
  const runtime = await agentModelRuntime(f.ctx.modelRegistry, f.ctx.model);
  const { session } = await createAgentSession({ cwd: f.root, model: f.ctx.model, modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(f.root), settingsManager: SettingsManager.inMemory(),
    resourceLoader: await agentLoader(f.root, "general-purpose"), customTools: fileTools,
    tools: ["read", "bash", "write", "edit", "grep", "find", "ls"] });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const write = session.agent.state.tools.find(tool => tool.name === "write");
  const edit = session.agent.state.tools.find(tool => tool.name === "edit");
  await write.execute("artifact", { path: "projects/report.txt", content: "old" });
  await edit.execute("update", { path: "projects/report.txt", edits: [{ oldText: "old", newText: "new" }] });
  assert.equal(await readFile(join(f.root, "projects/report.txt"), "utf8"), "new");
  const protectedPath = join(f.root, ".ffa/permissions.json"), before = await readFile(protectedPath, "utf8");
  await symlink(join(f.root, ".ffa"), join(f.root, "internal-alias"));
  for (const path of [protectedPath, pathToFileURL(protectedPath).href, "@" + protectedPath, "internal-alias/permissions.json"]) {
    await assert.rejects(write.execute("internal", { path, content: "{}" }));
    await assert.rejects(edit.execute("internal-edit", { path, edits: [{ oldText: before, newText: "{}" }] }));
  }
  assert.equal(await readFile(protectedPath, "utf8"), before);
  const outside = join(f.root, "../not-authorized/file.txt");
  await assert.rejects(write.execute("outside", { path: outside, content: "outside" }));
  await assert.rejects(access(join(f.root, "../not-authorized")));
});

test("workspace close cancels setup without changing workspace settings", async t => {
  const f = await fixture(t), service = f.instance.pythonEnvironment;
  const settings = await readFile(join(f.root, ".ffa/settings.json"), "utf8");
  const pending = service.setup();
  const rejected = assert.rejects(pending);
  await f.instance.close();
  await rejected;
  assert.equal(await readFile(join(f.root, ".ffa/settings.json"), "utf8"), settings);
  await assert.rejects(service.setup());
});

test("resuming a deferred approval checks changed permission before presenting it and never sends", async t => {
  const f = await fixture(t), cancel = f.instance.signal(undefined, true);
  let presented = false, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.confirmations.pause();
  const pending = f.execution.call(scope, "local", "write", { quantity: 1 }, async (value, recheck) => {
    entered(); await f.confirmations.ready(cancel); await recheck();
    presented = true; return approveLocally(value);
  }, cancel);
  const rejected = assert.rejects(pending);
  await waiting;
  await writeFile(join(f.root, ".ffa/permissions.json"), JSON.stringify({ default: "deny", tools: {} }));
  f.confirmations.resume(); await rejected;
  assert.equal(presented, false);
  assert.ok(f.store.calls.list().map(record => record.intent).every(intent => intent.state === "declined" && !intent.attempt));
});

test("native usage receipts count only persisted parent results and survive codemode metadata removal", async t => {
  const f = await fixture(t);
  // These are serialized accounting records, not a model execution or a simulated provider.
  const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 3, cacheWrite1h: 2, reasoning: 1, totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const value = { runId: "recorded-run", agent: "researcher", message: "Recorded calculation", mode: "foreground",
    state: "completed", createdAt: 1, startedAt: 2, finishedAt: 3, activity: "completed", report: "Recorded result", usage };
  f.session.sessionManager.appendCustomEntry("ffa.agent-run", value);
  f.session.sessionManager.appendCustomEntry("ffa.agent-usage", { runIds: [value.runId], toolCallId: "parent-codemode" });
  let branch = agentContext(f.ctx.sessionManager);
  f.agents.restore(branch.values, branch.reported);
  assert.equal(branch.reported.has(value.runId), false);
  assert.equal(f.agents.usage(branch.runIds).usage.totalTokens, 8);
  f.agents.reconcileUsage(branch.reported);
  assert.equal(f.agents.usage(branch.runIds).usage.reasoning, 1);
  const accountingAncestor = f.session.sessionManager.getLeafId();
  f.session.sessionManager.appendMessage({ role: "toolResult", toolName: "codemode", toolCallId: "parent-codemode",
    content: [{ type: "text", text: "Recorded accounting" }], isError: false, timestamp: Date.now(), usage, details: { calls: [] } });
  branch = agentContext(f.ctx.sessionManager);
  f.agents.restore(branch.values, branch.reported);
  assert.equal(branch.reported.has(value.runId), true);
  f.agents.reconcileUsage(branch.reported);
  assert.equal(f.agents.usage(branch.runIds).usage.totalTokens, 0);
  const reopened = new AgentService(f.execution);
  t.after(() => reopened.close());
  const recovered = agentContext(f.ctx.sessionManager);
  reopened.restore(recovered.values, recovered.reported);
  assert.equal(reopened.usage(recovered.runIds).usage.totalTokens, 0);
  f.session.sessionManager.branch(accountingAncestor);
  const alternative = agentContext(f.ctx.sessionManager);
  reopened.restore(alternative.values, alternative.reported);
  assert.equal(alternative.reported.has(value.runId), true);
  assert.equal(reopened.usage(alternative.runIds).usage.totalTokens, 0);
});

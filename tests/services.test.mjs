import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { host } from "./helpers/pi-host.mjs";
import { approveLocally } from "./helpers/local-confirmation.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ExpertRef } from "../dist/model/expert.js";
import { Store } from "../dist/storage/store.js";
import { begin, state } from "../dist/storage/workspace-state.js";
import { ProviderConnections } from "../dist/integrations/provider-connections.js";
import { PiExperts } from "../dist/integrations/pi-experts.js";
import { bindExpertRun } from "../dist/integrations/expert-tools.js";
import { ExpertService } from "../dist/services/expert-service.js";
import { ResearchService } from "../dist/services/research-service.js";
import { RecordService } from "../dist/services/record-service.js";
import { WorkspaceInstance } from "../dist/extension/lifecycle.js";
import { mainTools } from "../dist/tools/register.js";
import { ProviderRegistry } from "../dist/services/provider-registry.js";
import { parseProvider, providerData } from "../dist/services/provider-config.js";
import { ExecutionService } from "../dist/services/execution-service.js";
import { Ledger } from "../dist/services/execution-ledger.js";
import { InitializationService, prepareDirectories } from "../dist/services/initialization-service.js";
import { Confirmations } from "../dist/ui/confirmation.js";
import { Provider, Operation } from "../dist/model/provider.js";
import { Receipt } from "../dist/model/receipt.js";
import { Intent } from "../dist/model/execution-intent.js";
import { canonical, json } from "../dist/common/json.js";

const provider = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf", operations: [
  { name: "echo", description: "Read explicit JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
  { name: "write", description: "Never sent in these tests", inputSchema: { type: "object", required: ["quantity"],
    properties: { quantity: { type: "integer", minimum: 1 } }, additionalProperties: false }, argv: ["%s", { json: true }],
    outcomes: { accepted: { const: true }, rejected: { const: false } } },
] };
const scope = { session: "local-session", request: "request" };

async function fixture(t) {
  const { root, session, api } = await host(t);
  const current = await begin(root), store = new Store(join(root, ".ffa"));
  store.put("provider", provider.id, providerData(parseProvider(provider)));
  const connections = new ProviderConnections(root);
  const providers = new ProviderRegistry(store, connections, () => execution.revoke(), root);
  const execution = new ExecutionService(providers, store);
  await providers.permissions.initialize();
  await writeFile(join(root, ".ffa/permissions.json"), JSON.stringify({ default: "ask", tools: { "local/echo": "allow", "local/write": "review" } }));
  const confirmations = new Confirmations(), ctx = session.extensionRunner.createToolContext("local", undefined);
  const confirm = value => confirmations.ask(ctx, "Local boundary check", value);
  const initialization = new InitializationService(root, current, store, providers);
  const research = new ResearchService(root, store), records = new RecordService(store), experts = new ExpertService(execution);
  const instance = new WorkspaceInstance(root, store, providers, execution, initialization, research, records, experts);
  const expertHost = new PiExperts();
  const bindRun = (context, signal, progress) => bindExpertRun(api, expertHost, providers, records, research, instance, context, signal, progress, confirmations);
  return { root, current, store, providers, execution, confirm, ctx, confirmations, experts, instance, bindRun,
    close: () => instance.close() };
}

test("data classes serialize explicitly without changing stored business values", async t => {
  const f = await fixture(t);
  try {
    const parsed = parseProvider(provider);
    assert.ok(parsed instanceof Provider); assert.ok(parsed.operations[0] instanceof Operation);
    assert.throws(() => canonical(parsed));
    assert.deepEqual(json(providerData(parsed)), provider);
    const query = { value: 42 }, pending = f.execution.call(scope, "local", "echo", query, approveLocally);
    query.value = 99;
    const receipt = await pending;
    assert.ok(receipt instanceof Receipt);
    assert.deepEqual(receipt.data, { value: 42 });
    assert.deepEqual(receipt.parameters, { value: 42 });
    assert.equal(receipt.provider, "local");
    assert.equal(Object.hasOwn(receipt, "source"), false);
    assert.deepEqual(f.store.get("receipt", receipt.id), json({ ...receipt }));
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    assert.ok(intent instanceof Intent);
    assert.equal(intent.provider, "local");
    assert.equal(Object.hasOwn(intent, "source"), false);
    assert.deepEqual(f.store.get("intent", intent.id), json({ ...intent }));
    intent.state = "closed"; intent.parameters.quantity = 99;
    assert.equal(f.execution.get(intent.id).state, "prepared");
    assert.equal(f.execution.get(intent.id).parameters.quantity, 1);
    assert.equal(f.providers.permission("local", "write"), "review");
  } finally { await f.close(); }
});

test("direct services reject wrong permissions, invalid parameters and absent review without sending", async t => {
  const f = await fixture(t);
  try {
    assert.throws(() => f.instance.records.read("setting", "python"));
    await assert.rejects(f.execution.call(scope, "local", "write", { quantity: 1 }, approveLocally));
    await assert.rejects(f.execution.call(scope, "local", "absent", {}, f.confirm));
    await assert.rejects(f.execution.prepare(scope, "invalid", "local", "write", { quantity: 0 }));
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    await assert.rejects(f.execution.execute(intent.id, scope, f.confirm));
    assert.equal(f.execution.get(intent.id).attempt, undefined);
    await assert.rejects(f.providers.configure({ ...provider, id: "other" }, f.confirm));
    assert.deepEqual(f.providers.list().map(value => value.id), ["local"]);
  } finally { await f.close(); }
});

test("revoked requests and changed bindings invalidate reviewed provider calls", async t => {
  const f = await fixture(t);
  try {
    const receipt = await f.execution.call(scope, "local", "echo", { evidence: true }, approveLocally);
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    const generation = f.execution.generation;
    f.execution.review(intent.id, scope, generation, "local-review", true, [receipt.id], "Local evidence");
    f.execution.revoke();
    assert.throws(() => f.execution.review(intent.id, scope, generation, "old-review", true, [receipt.id], "Old request"));
    await assert.rejects(f.execution.execute(intent.id, scope, f.confirm));
    assert.throws(() => f.execution.review(intent.id, scope, f.execution.generation, "local-review", true, [receipt.id], "Expired preparation"));
    await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    f.execution.review(intent.id, scope, f.execution.generation, "local-review", true, [receipt.id], "Local evidence");
    const changed = providerData(f.providers.provider("local"));
    changed.operations[1].description = "Changed contract";
    f.store.put("provider", "local", changed);
    await assert.rejects(f.execution.execute(intent.id, scope, f.confirm));
    assert.equal(f.execution.get(intent.id).attempt, undefined);
  } finally { await f.close(); }
});

test("unsettled ledger facts block direct preparation without invoking a write operation", async t => {
  const f = await fixture(t);
  try {
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    const ledger = new Ledger(f.store);
    ledger.start(intent.id); ledger.unknown(intent.id);
    await assert.rejects(f.execution.prepare({ ...scope, request: "new" }, "new", "local", "write", { quantity: 2 }));
    assert.equal(f.execution.unsettled().length, 1);
    assert.equal(f.execution.get(intent.id).observation, undefined);
  } finally { await f.close(); }
});

test("initialization service retains pending state and user documents when real noninteractive confirmation rejects", async t => {
  const f = await fixture(t);
  try {
    const service = new InitializationService(f.root, f.current, f.store, f.providers);
    await prepareDirectories(f.root);
    await writeFile(join(f.root, "AGENTS.md"), "User-owned instructions");
    await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
    await mkdir(join(f.root, "providers/local"));
    await writeFile(join(f.root, "providers/local/GUIDE.md"), "Provider guide");
    const quote = await f.execution.call(scope, "local", "echo", { quote: true }, approveLocally);
    const history = await f.execution.call(scope, "local", "echo", { history: true }, approveLocally);
    const cancel = new AbortController().signal;
    await assert.rejects(service.complete({ market: "local", quote: quote.id, history: quote.id }, f.confirm, cancel));
    await assert.rejects(service.complete({ market: "local", quote: quote.id, history: history.id }, f.confirm, cancel));
    assert.equal(service.snapshot().status, "pending");
    assert.equal((await state(f.root)).status, "pending");
    assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "User-owned instructions");
  } finally { await f.close(); }
});

test("initialization accepts a complete catalog with default approval for undocumented tools", async t => {
  const f = await fixture(t);
  try {
    const configured = providerData(f.providers.provider("local"));
    configured.operations.push({ name: "undocumented", description: "", inputSchema: { type: "object" }, argv: ["%s", { json: true }] });
    f.store.put("provider", "local", providerData(parseProvider(configured)));
    const quote = await f.execution.call(scope, "local", "echo", { quote: true }, approveLocally);
    const history = await f.execution.call(scope, "local", "echo", { history: true }, approveLocally);
    await prepareDirectories(f.root);
    await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
    await mkdir(join(f.root, "providers/local"));
    await writeFile(join(f.root, "providers/local/GUIDE.md"), "Known capabilities");
    await f.instance.initialization.complete({ market: "local", quote: quote.id, history: history.id }, approveLocally, f.instance.signal());
    assert.equal(f.instance.initialization.snapshot().status, "ready");
    assert.equal(f.providers.permission("local", "undocumented"), "ask");
  } finally { await f.close(); }
});

test("pending workspace exposes only initialization capabilities with valid structured query results", async t => {
  const f = await fixture(t);
  try {
    const tools = mainTools(f.instance, f.instance, f.confirmations, f.bindRun);
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      "ffa_configure_provider", "ffa_discover_provider", "ffa_finish_initialization", "ffa_provider_call", "ffa_providers", "ffa_record",
    ]);
    const read = tools.find(tool => tool.name === "ffa_provider_call");
    const value = await read.execute("local", { provider: "local", operation: "echo", parameters: { n: 1 } }, undefined, undefined, f.ctx);
    const { schema } = await import("../dist/common/validation.js");
    assert.ok(schema(read.outputSchema)(value.structuredContent));
    assert.deepEqual(value.structuredContent.data, { n: 1 });
    assert.throws(() => f.instance.check(true));
  } finally { await f.close(); }
});

test("expert service rejects invalid branch references and review scopes before session execution", async t => {
  const f = await fixture(t);
  try {
    const signal = f.instance.signal();
    assert.throws(() => f.experts.prepare({ role: "researcher", goal: "local", expertId: "absent" }, [], scope, signal));
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    assert.throws(() => f.experts.prepare({ role: "researcher", goal: "local", intentId: intent.id }, [], scope, signal));
    assert.throws(() => f.experts.prepare({ role: "reviewer", goal: "local" }, [], scope, signal));
    assert.throws(() => f.experts.prepare({ role: "reviewer", goal: "local", intentId: intent.id }, [], { ...scope, request: "other" }, signal));
    assert.equal(f.execution.get(intent.id).review, undefined);
    assert.equal(f.execution.get(intent.id).attempt, undefined);
  } finally { await f.close(); }
});

test("expert default approval uses the local confirmation and expires with the request", async t => {
  const f = await fixture(t);
  try {
    await writeFile(join(f.root, ".ffa/permissions.json"), JSON.stringify({ default: "ask", tools: {} }));
    f.providers.permissions.read();
    const task = f.experts.prepare({ role: "researcher", goal: "Read local JSON" }, [], scope, f.instance.signal());
    const receipt = await task.call(scope, "local", "echo", { independent: true }, approveLocally);
    assert.equal(receipt.success, true); assert.deepEqual(receipt.data, { independent: true });
    await assert.rejects(task.call(scope, "local", "write", { quantity: 1 }, f.confirm));
    f.execution.revoke();
    await assert.rejects(task.call(scope, "local", "echo", {}, approveLocally));
  } finally { await f.close(); }
});

test("review capabilities accept only their own real query evidence and expire with the request", async t => {
  const f = await fixture(t);
  try {
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    const task = f.experts.prepare({ role: "reviewer", goal: "local", intentId: intent.id }, [], scope, f.instance.signal());
    const foreign = await f.execution.call(scope, "local", "echo", { foreign: true }, approveLocally);
    const own = await task.call(scope, "local", "echo", { independent: true }, approveLocally);
    assert.throws(() => task.submitReview({ approved: true, evidenceIds: [own.id], note: "Not yet associated with a session" }));
    const manager = SessionManager.create(f.root, join(f.root, "expert-sessions"));
    manager.appendCustomEntry("local-check", { intentId: intent.id });
    const ref = new ExpertRef({ id: manager.getSessionId(), role: "reviewer", file: manager.getSessionFile() });
    task.remember(ref);
    assert.throws(() => task.submitReview({ approved: true, evidenceIds: [foreign.id], note: "Foreign evidence" }));
    task.submitReview({ approved: true, evidenceIds: [own.id], note: "Independent local evidence" });
    assert.deepEqual(f.execution.get(intent.id).review.evidence, [own.id]);
    assert.equal(f.execution.get(intent.id).review.expert, ref.id);
    f.execution.revoke();
    assert.throws(() => task.submitReview({ approved: true, evidenceIds: [own.id], note: "Expired request" }));
    assert.throws(() => task.remember(ref));
    await assert.rejects(task.call(scope, "local", "echo", {}, approveLocally));
    assert.equal(f.execution.get(intent.id).attempt, undefined);
  } finally { await f.close(); }
});

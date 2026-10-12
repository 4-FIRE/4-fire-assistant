import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { host } from "./helpers/pi-host.mjs";
import { approveLocally, localConfirmation } from "./helpers/local-confirmation.mjs";
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
import { InitializationService, prepareDirectories } from "../dist/services/initialization-service.js";
import { Confirmations } from "../dist/ui/confirmation.js";
import { Provider, Operation } from "../dist/model/provider.js";
import { Intent } from "../dist/model/execution-intent.js";
import { canonical, json } from "../dist/common/json.js";

const provider = { id: "local", kind: "cli", coverage: { basis: "printf(1)", limitations: ["Only JSON output is described"] }, command: "/usr/bin/printf", operations: [
  { name: "echo", description: "Read explicit JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
  { name: "write", description: "Print quantity", inputSchema: { type: "object", required: ["quantity"],
    properties: { quantity: { type: "integer", minimum: 1 } }, additionalProperties: false }, argv: ["%s", { json: true }] },
] };
const scope = { session: "local-session" };

async function fixture(t) {
  const { root, session, api } = await host(t);
  const current = await begin(root), store = new Store(join(root, ".ffa"));
  store.put("provider", provider.id, providerData(parseProvider(provider)));
  const providers = new ProviderRegistry(store, new ProviderConnections(root), root);
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
  t.after(() => instance.close());
  return { root, current, store, providers, execution, confirm, ctx, confirmations, experts, instance, bindRun };
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
  assert.ok(intent instanceof Intent);
  assert.deepEqual(intent.observation.data, { value: 42 });
  assert.deepEqual(intent.parameters, { value: 42 });
  assert.deepEqual(f.store.get("intent", intent.id), json({ ...intent }));
  intent.parameters.value = 99;
  assert.equal(f.execution.get(intent.id).parameters.value, 42);
  const receipt = f.store.get("receipt", intent.receiptId);
  assert.deepEqual(receipt.parameters, { value: 42 });
  assert.equal(receipt.provider, "local");
});

test("invalid parameters and noninteractive approval reject without sending", async t => {
  const f = await fixture(t);
  assert.throws(() => f.instance.records.read("setting", "python"));
  await assert.rejects(f.execution.call(scope, "local", "write", { quantity: 1 }, f.confirm));
  await assert.rejects(f.execution.call(scope, "local", "absent", {}, f.confirm));
  await assert.rejects(f.execution.call(scope, "local", "write", { quantity: 0 }, approveLocally));
  assert.ok(f.store.list("intent").every(intent => !intent.attempt));
  await assert.rejects(f.providers.configure({ ...provider, id: "other" }, f.confirm));
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
  const f = await fixture(t), service = new InitializationService(f.root, f.current, f.store, f.providers);
  await prepareDirectories(f.root);
  await writeFile(join(f.root, "AGENTS.md"), "User-owned instructions");
  await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
  await mkdir(join(f.root, "providers/local"));
  await writeFile(join(f.root, "providers/local/GUIDE.md"), "Provider guide");
  const quote = await f.execution.call(scope, "local", "echo", { quote: true }, approveLocally);
  const history = await f.execution.call(scope, "local", "echo", { history: true }, approveLocally);
  const signal = f.instance.signal();
  await assert.rejects(service.complete({ market: "local", quote: quote.receiptId, history: quote.receiptId }, f.confirm, signal));
  await assert.rejects(service.complete({ market: "local", quote: quote.receiptId, history: history.receiptId }, f.confirm, signal));
  assert.equal(service.snapshot().status, "pending");
  assert.equal((await state(f.root)).status, "pending");
  assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "User-owned instructions");
});

test("initialization accepts complete catalogs and current successful receipts", async t => {
  const f = await fixture(t);
  const configured = providerData(f.providers.provider("local"));
  configured.operations.push({ name: "undocumented", description: "", inputSchema: { type: "object" }, argv: ["%s", { json: true }] });
  f.store.put("provider", "local", providerData(parseProvider(configured)));
  const quote = await f.execution.call(scope, "local", "echo", { quote: true }, approveLocally);
  const history = await f.execution.call(scope, "local", "echo", { history: true }, approveLocally);
  await prepareDirectories(f.root);
  await writeFile(join(f.root, "providers/AGENTS.md"), "Provider index");
  await mkdir(join(f.root, "providers/local"));
  await writeFile(join(f.root, "providers/local/GUIDE.md"), "Known capabilities");
  await f.instance.initialization.complete({ market: "local", quote: quote.receiptId, history: history.receiptId }, approveLocally, f.instance.signal());
  assert.equal(f.instance.initialization.snapshot().status, "ready");
  assert.equal(f.providers.permission("local", "undocumented"), "ask");
});

test("pending workspace exposes initialization tools and structured call and read results", async t => {
  const f = await fixture(t), tools = mainTools(f.instance, f.instance, f.confirmations, f.bindRun);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "ffa_configure_provider", "ffa_discover_provider", "ffa_finish_initialization", "ffa_provider_call", "ffa_providers",
  ]);
  const call = tools.find(tool => tool.name === "ffa_provider_call");
  const value = await call.execute("local", { provider: "local", operation: "echo", parameters: { n: 1 } }, undefined, undefined, f.ctx);
  const { schema } = await import("../dist/common/validation.js");
  assert.ok(schema(call.outputSchema)(value.structuredContent));
  assert.deepEqual(value.structuredContent.data, { n: 1 });
  const record = await call.execute("read", { record: { kind: "receipt", id: value.structuredContent.receiptId } }, undefined, undefined, f.ctx);
  assert.ok(schema(call.outputSchema)(record.structuredContent));
  assert.deepEqual(JSON.parse(record.structuredContent.text).data, { n: 1 });
  assert.throws(() => f.instance.check(true));
});

test("expert branch references retain role and new independent reviewer boundaries", async t => {
  const f = await fixture(t), signal = f.instance.signal();
  assert.throws(() => f.experts.prepare({ role: "researcher", goal: "local", expertId: "absent" }, [], scope, signal));
  const refs = [{ id: "known", role: "researcher", file: "/local/reference" }];
  assert.throws(() => f.experts.prepare({ role: "reviewer", goal: "local", expertId: "known" }, refs, scope, signal));
  const reviewers = [{ ...refs[0], role: "reviewer" }];
  assert.throws(() => f.experts.prepare({ role: "reviewer", goal: "local", expertId: "known" }, reviewers, scope, signal));
  const task = f.experts.prepare({ role: "reviewer", goal: "Review this plan and its quantities" }, [], scope, signal);
  const intent = await task.call("local", "echo", { independent: true }, approveLocally);
  assert.equal(intent.state, "observed"); assert.deepEqual(intent.observation.data, { independent: true });
});

test("expert calls use the same permission and cancellation boundary", async t => {
  const f = await fixture(t), signal = f.instance.signal();
  const task = f.experts.prepare({ role: "reviewer", goal: "Verify local numbers" }, [], scope, signal);
  const intent = await task.call("local", "write", { quantity: 1 }, approveLocally);
  assert.equal(intent.permission, "review"); assert.equal(intent.state, "observed");
  await assert.rejects(task.call("local", "write", { quantity: 2 }, f.confirm));
  f.instance.cancelWork();
  await assert.rejects(async () => task.call("local", "echo", {}, approveLocally));
});

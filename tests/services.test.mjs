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
import { SourceConnections } from "../dist/integrations/source-connections.js";
import { PiExperts } from "../dist/integrations/pi-experts.js";
import { bindExpertRun } from "../dist/integrations/expert-tools.js";
import { ExpertService } from "../dist/services/expert-service.js";
import { ResearchService } from "../dist/services/research-service.js";
import { RecordService } from "../dist/services/record-service.js";
import { WorkspaceInstance } from "../dist/extension/lifecycle.js";
import { mainTools } from "../dist/tools/register.js";
import { SourceService } from "../dist/services/source-service.js";
import { parseSource, sourceData } from "../dist/services/source-config.js";
import { ExecutionService } from "../dist/services/execution-service.js";
import { Ledger } from "../dist/services/execution-ledger.js";
import { InitializationService, prepareDirectories } from "../dist/services/initialization-service.js";
import { Confirmations } from "../dist/ui/confirmation.js";
import { Source, Operation } from "../dist/model/source.js";
import { Receipt } from "../dist/model/receipt.js";
import { Intent } from "../dist/model/execution-intent.js";
import { canonical, json } from "../dist/common/json.js";

const source = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "/usr/bin/printf", operations: [
  { name: "echo", description: "Read explicit JSON", effect: "observe", assessment: "understood", analysis: { purpose: "Read local data", basis: "Local CLI contract", consequences: "No business state change", related: [], impacts: [], execution: "confirmation" }, inputSchema: { type: "object" }, argv: ["%s", { json: true }] },
  { name: "write", description: "Never sent in these tests", effect: "change", assessment: "understood", analysis: { purpose: "Check controlled execution", basis: "Local CLI contract", consequences: "Requires review", related: [], impacts: ["orders"], execution: "independent" }, inputSchema: { type: "object", required: ["quantity"],
    properties: { quantity: { type: "integer", minimum: 1 } }, additionalProperties: false }, argv: ["%s", { json: true }],
    outcomes: { accepted: { const: true }, rejected: { const: false } } },
] };
const scope = { session: "local-session", request: "request" };

async function fixture(t) {
  const { root, session, api } = await host(t);
  const current = await begin(root), store = new Store(join(root, ".ffa"));
  store.put("source", source.id, sourceData(parseSource(source)));
  const connections = new SourceConnections(root);
  const sources = new SourceService(store, connections, () => execution.revoke());
  const execution = new ExecutionService(sources, store);
  const confirmations = new Confirmations(), ctx = session.extensionRunner.createToolContext("local", undefined);
  const confirm = value => confirmations.ask(ctx, "Local boundary check", value);
  const initialization = new InitializationService(root, current, store, sources);
  const research = new ResearchService(root, store), records = new RecordService(store), experts = new ExpertService(sources, execution);
  const instance = new WorkspaceInstance(root, store, sources, execution, initialization, research, records, experts);
  const expertHost = new PiExperts();
  const bindRun = (context, signal, progress) => bindExpertRun(api, expertHost, sources, records, research, instance, context, signal, progress);
  return { root, current, store, sources, execution, confirm, ctx, confirmations, experts, instance, bindRun,
    close: () => instance.close() };
}

test("data classes serialize explicitly without changing stored business values", async t => {
  const f = await fixture(t);
  try {
    const parsed = parseSource(source);
    assert.ok(parsed instanceof Source); assert.ok(parsed.operations[0] instanceof Operation);
    assert.throws(() => canonical(parsed));
    assert.deepEqual(json(sourceData(parsed)), source);
    const query = { value: 42 }, pending = f.sources.read("local", "echo", query);
    query.value = 99;
    const receipt = await pending;
    assert.ok(receipt instanceof Receipt);
    assert.deepEqual(receipt.data, { value: 42 });
    assert.deepEqual(receipt.parameters, { value: 42 });
    assert.deepEqual(f.store.get("receipt", receipt.id), json({ ...receipt }));
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    assert.ok(intent instanceof Intent);
    assert.deepEqual(f.store.get("intent", intent.id), json({ ...intent }));
    intent.state = "closed"; intent.parameters.quantity = 99;
    assert.equal(f.execution.get(intent.id).state, "prepared");
    assert.equal(f.execution.get(intent.id).parameters.quantity, 1);
    assert.equal(f.sources.source("local").operations[1].effect, "change");
  } finally { await f.close(); }
});

test("direct services reject wrong permissions, invalid parameters and absent review without sending", async t => {
  const f = await fixture(t);
  try {
    assert.throws(() => f.instance.records.read("setting", "python"));
    await assert.rejects(f.sources.read("local", "write", { quantity: 1 }));
    await assert.rejects(f.execution.prepare(scope, "wrong permission", "local", "echo", {}));
    await assert.rejects(f.execution.prepare(scope, "invalid", "local", "write", { quantity: 0 }));
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    await assert.rejects(f.execution.execute(intent.id, scope, f.confirm));
    assert.equal(f.execution.get(intent.id).attempt, undefined);
    await assert.rejects(f.sources.configure({ ...source, id: "other" }, f.confirm));
    assert.deepEqual(f.sources.list().map(value => value.id), ["local"]);
  } finally { await f.close(); }
});

test("revoked requests and changed bindings invalidate reviewed service calls", async t => {
  const f = await fixture(t);
  try {
    const receipt = await f.sources.read("local", "echo", { evidence: true });
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    const generation = f.execution.generation;
    f.execution.review(intent.id, scope, generation, "local-review", true, [receipt.id], "Local evidence");
    f.execution.revoke();
    assert.throws(() => f.execution.review(intent.id, scope, generation, "old-review", true, [receipt.id], "Old request"));
    await assert.rejects(f.execution.execute(intent.id, scope, f.confirm));
    f.execution.review(intent.id, scope, f.execution.generation, "local-review", true, [receipt.id], "Local evidence");
    const changed = sourceData(f.sources.source("local"));
    changed.operations[1].description = "Changed contract";
    f.store.put("source", "local", changed);
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
    const service = new InitializationService(f.root, f.current, f.store, f.sources);
    await prepareDirectories(f.root);
    await writeFile(join(f.root, "AGENTS.md"), "User-owned instructions");
    await writeFile(join(f.root, "sources/AGENTS.md"), "Source index");
    await mkdir(join(f.root, "sources/local"));
    await writeFile(join(f.root, "sources/local/GUIDE.md"), "Source guide");
    const quote = await f.sources.read("local", "echo", { quote: true });
    const history = await f.sources.read("local", "echo", { history: true });
    const cancel = new AbortController().signal;
    await assert.rejects(service.complete({ market: "local", quote: quote.id, history: quote.id }, f.confirm, cancel));
    await assert.rejects(service.complete({ market: "local", quote: quote.id, history: history.id }, f.confirm, cancel));
    assert.equal(service.snapshot().status, "pending");
    assert.equal((await state(f.root)).status, "pending");
    assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "User-owned instructions");
  } finally { await f.close(); }
});

test("initialization requires analysis of every available capability and allows documented uncertainty", async t => {
  const f = await fixture(t);
  try {
    const configured = sourceData(f.sources.source("local"));
    configured.operations.push({ name: "undocumented", description: "Needs analysis", inputSchema: { type: "object" }, effect: "unresolved", assessment: "unassessed" });
    f.store.put("source", "local", sourceData(parseSource(configured)));
    let quote = await f.sources.read("local", "echo", { quote: true });
    let history = await f.sources.read("local", "echo", { history: true });
    const service = f.instance.initialization, signal = f.instance.signal();
    await assert.rejects(service.complete({ market: "local", quote: quote.id, history: history.id }, approveLocally, signal));
    await assert.rejects(readFile(join(f.root, "AGENTS.md")));
    configured.operations[2].assessment = "uncertain";
    configured.operations[2].analysis = { purpose: "Unknown native capability", basis: "Available docs do not describe effects",
      consequences: "Uncertain, do not execute", related: [], impacts: [], execution: "independent" };
    f.store.put("source", "local", sourceData(parseSource(configured)));
    quote = await f.sources.read("local", "echo", { quote: true });
    history = await f.sources.read("local", "echo", { history: true });
    await prepareDirectories(f.root);
    await writeFile(join(f.root, "sources/AGENTS.md"), "Source index");
    await mkdir(join(f.root, "sources/local"));
    await writeFile(join(f.root, "sources/local/GUIDE.md"), "Known capabilities and uncertainty");
    await service.complete({ market: "local", quote: quote.id, history: history.id }, approveLocally, signal);
    assert.equal(service.snapshot().status, "ready");
    assert.equal(f.sources.operation("local", "undocumented").effect, "unresolved");
  } finally { await f.close(); }
});

test("pending workspace exposes only initialization capabilities with valid structured query results", async t => {
  const f = await fixture(t);
  try {
    const tools = mainTools(f.instance, f.instance, f.confirmations, f.bindRun);
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      "ffa_configure_source", "ffa_discover_source", "ffa_finish_initialization", "ffa_record", "ffa_source_read", "ffa_sources",
    ]);
    const read = tools.find(tool => tool.name === "ffa_source_read");
    const value = await read.execute("local", { source: "local", operation: "echo", parameters: { n: 1 } }, undefined, undefined, f.ctx);
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

test("review capabilities accept only their own real query evidence and expire with the request", async t => {
  const f = await fixture(t);
  try {
    const intent = await f.execution.prepare(scope, "local check", "local", "write", { quantity: 1 });
    const task = f.experts.prepare({ role: "reviewer", goal: "local", intentId: intent.id }, [], scope, f.instance.signal());
    const foreign = await f.sources.read("local", "echo", { foreign: true });
    const own = await task.read("local", "echo", { independent: true });
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
    assert.equal(f.execution.get(intent.id).attempt, undefined);
  } finally { await f.close(); }
});

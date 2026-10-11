import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/storage/store.js";
import { SourceConnections } from "../dist/integrations/source-connections.js";
import { SourceService } from "../dist/services/source-service.js";
import { ExecutionService } from "../dist/services/execution-service.js";
import { Ledger } from "../dist/services/execution-ledger.js";
import { parseSource, sourceData } from "../dist/services/source-config.js";
import { mergeCatalog, checkCatalogEdit } from "../dist/services/source-catalog.js";
import { localConfirmation, approveLocally } from "./helpers/local-confirmation.mjs";

const analysis = { purpose: "Append a local note", basis: "tee(1) with explicit filename and JSON stdin",
  consequences: "Append input to the selected file", related: [], impacts: [], execution: "confirmation" };
const scope = { session: "local", request: "one" };
const definition = { name: "manage", description: "Unclassified native operation", inputSchema: { type: "object" },
  outputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
const connection = { id: "catalog", kind: "mcp", url: "https://example.invalid/mcp", operations: [] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".ffa"));
  const store = new Store(join(root, ".ffa"));
  t.after(() => store.close());
  const sources = new SourceService(store, new SourceConnections(root), () => execution.revoke());
  const execution = new ExecutionService(sources, store);
  const operation = { name: "append", description: "Append JSON to a local file", inputSchema: { type: "object",
    additionalProperties: false, required: ["file", "note"], properties: { file: { type: "string" }, note: { type: "string" } } },
    effect: "change", assessment: "understood", analysis,
    argv: ["-a", { parameter: "file" }], stdin: true,
    outcomes: { accepted: { type: "object", required: ["file", "note"] }, rejected: { const: false } } };
  const source = { id: "notes", kind: "cli", command: "/usr/bin/tee", coverage: { basis: "tee(1)", limitations: ["Only append is described"] }, operations: [operation] };
  store.put("source", source.id, sourceData(parseSource(source)));
  t.after(() => sources.close());
  return { root, store, sources, execution, source, operation };
}

test("catalog retains every definition, ignores read hints for authorization, and revokes changed or returning capabilities", () => {
  const first = mergeCatalog(parseSource(connection), [definition, { ...definition, name: "other" }]);
  assert.equal(first.operations.length, 2);
  assert.ok(first.operations.every(op => op.effect === "unresolved" && op.assessment === "unassessed"));
  assert.deepEqual(first.operations[0].native, definition);
  assert.equal(first.discovery.status, "complete");
  const understood = sourceData(first);
  understood.operations[0] = { ...understood.operations[0], effect: "observe", assessment: "understood", analysis };
  checkCatalogEdit(parseSource(understood), first);
  const same = mergeCatalog(parseSource(understood), [definition, { ...definition, name: "other" }]);
  assert.equal(same.operations[0].effect, "observe");
  const changed = mergeCatalog(same, [{ ...definition, description: "Changed meaning with unchanged input schema" }]);
  assert.equal(changed.operations[0].effect, "unresolved");
  assert.equal(changed.operations.find(op => op.name === "other").available, false);
  const returned = mergeCatalog(changed, [definition, { ...definition, name: "other" }]);
  assert.ok(returned.operations.every(op => op.effect === "unresolved"));
  assert.throws(() => mergeCatalog(first, [definition, definition]));
  assert.equal(first.operations.length, 2);
});

test("catalog edits cannot invent discovery, omit tools, alter native definitions or enable unknown impacts", () => {
  const discovered = mergeCatalog(parseSource(connection), [definition, { ...definition, name: "other" }]);
  assert.throws(() => checkCatalogEdit(discovered, undefined));
  const edited = sourceData(discovered);
  edited.operations.pop();
  assert.throws(() => checkCatalogEdit(parseSource(edited), discovered));
  const altered = sourceData(discovered);
  altered.operations[0].native.outputSchema = { type: "string" };
  assert.throws(() => checkCatalogEdit(parseSource(altered), discovered));
  assert.throws(() => parseSource({ ...connection, operations: [{ ...discovered.operations[0], assessment: "understood" }] }));
  const uncertain = { ...discovered.operations[0], assessment: "uncertain", analysis: { ...analysis, basis: "Docs conflict", consequences: "Unknown" } };
  assert.equal(parseSource({ ...connection, operations: [uncertain] }).operations[0].assessment, "uncertain");
});

test("a real failed MCP process preserves the directory and cannot grant access", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const mcp = parseSource({ id: "failed", kind: "mcp", command: "/usr/bin/false", operations: [] });
  await f.sources.configure(sourceData(mcp), approveLocally);
  assert.equal(f.sources.source("failed").operations.length, 0);
  const known = mergeCatalog(mcp, [definition]);
  f.store.put("source", "failed", sourceData(known));
  await assert.rejects(f.sources.discover("failed"));
  const after = f.sources.source("failed");
  assert.equal(after.discovery.status, "failed");
  assert.deepEqual(after.operations, known.operations);
  await assert.rejects(f.sources.read("failed", "manage", {}));
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(f.sources.discover("failed", canceled.signal));
  assert.deepEqual(f.sources.source("failed").operations, known.operations);
});

test("changed connections keep the old inventory disabled until fresh discovery", async t => {
  const f = await fixture(t);
  const known = mergeCatalog(parseSource(connection), [definition]);
  f.store.put("source", known.id, sourceData(known));
  await f.sources.configure({ ...connection, url: "https://other.invalid/mcp" }, approveLocally);
  const next = f.sources.source(known.id);
  assert.equal(next.operations.length, 1);
  assert.equal(next.operations[0].available, false);
  assert.equal(next.operations[0].effect, "unresolved");
  assert.equal(next.discovery.status, "stale");
});

test("sensitive consequences require independent review rather than a business module name", async t => {
  const f = await fixture(t);
  for (const impact of ["funds", "orders", "automation", "permissions", "destruction", "unfamiliar-impact"]) {
    const operation = { ...f.operation, analysis: { ...analysis, impacts: [impact] } };
    assert.throws(() => parseSource({ ...f.source, operations: [operation] }));
    operation.analysis.execution = "independent";
    assert.equal(parseSource({ ...f.source, operations: [operation] }).operations[0].analysis.execution, "independent");
  }
  assert.throws(() => parseSource({ ...f.source, coverage: undefined }));
  assert.throws(() => checkCatalogEdit(parseSource({ ...f.source, operations: [] }), parseSource(f.source)));
});

test("ordinary changes pass the real local confirmation component and append at most once", async t => {
  const f = await fixture(t), file = join(f.root, "notes.json"), args = { file, note: "local" };
  const intent = await f.execution.prepare(scope, "Append note", "notes", "append", args);
  assert.equal(intent.execution, "confirmation");
  const confirmation = localConfirmation();
  const pending = f.execution.execute(intent.id, scope, confirmation.ask);
  const { dialog, value } = await confirmation.ready;
  assert.equal(value.execution, "confirmation");
  assert.deepEqual(value.analysis, analysis);
  assert.equal(value.invocation.stdin, JSON.stringify(args));
  await assert.rejects(f.execution.execute(intent.id, scope, confirmation.ask));
  await assert.rejects(readFile(file));
  dialog.handleInput("\t"); dialog.handleInput("\r");
  const result = await pending;
  assert.equal(result.state, "observed"); assert.equal(result.outcome, "accepted");
  assert.equal(result.review, undefined); assert.ok(result.attempt);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
  assert.equal((await f.execution.execute(intent.id, scope, confirmation.ask)).attempt.id, result.attempt.id);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
});

test("ordinary change confirmation, cancellation and request revocation do not send", async t => {
  const f = await fixture(t), file = join(f.root, "not-written");
  for (const action of ["decline", "abort", "revoke", "change-contract"]) {
    const callScope = { ...scope, request: action };
    const signal = new AbortController();
    const intent = await f.execution.prepare(callScope, action, "notes", "append", { file, note: action });
    const confirmation = localConfirmation(signal.signal);
    const pending = f.execution.execute(intent.id, callScope, confirmation.ask, signal.signal);
    const { dialog } = await confirmation.ready;
    if (action === "decline") dialog.handleInput("\r");
    else if (action === "abort") signal.abort();
    else {
      if (action === "revoke") f.execution.revoke();
      else {
        const changed = sourceData(f.sources.source("notes"));
        changed.operations[0].analysis.consequences = "Changed meaning";
        f.store.put("source", "notes", changed);
      }
      dialog.handleInput("\t"); dialog.handleInput("\r");
    }
    if (action === "decline") assert.equal((await pending).state, "declined");
    else await assert.rejects(pending);
    assert.equal(f.execution.get(intent.id).attempt, undefined);
    await assert.rejects(readFile(file));
  }
});

test("unresolved, prohibited and unavailable capabilities remain visible and cannot execute", async t => {
  const f = await fixture(t);
  for (const extra of [{ effect: "unresolved", assessment: "unassessed" }, { blocked: "User prohibited" }, { available: false }]) {
    const source = parseSource({ ...f.source, operations: [{ ...f.operation, ...extra }] });
    f.store.put("source", source.id, sourceData(source));
    assert.equal(f.sources.catalog()[0].operations.length, 1);
    await assert.rejects(f.sources.read("notes", "append", { file: join(f.root, "note"), note: "local" }));
    await assert.rejects(f.execution.prepare(scope, "local", "notes", "append", { file: join(f.root, "note"), note: "local" }));
  }
});

test("source classification and execution requirements are mandatory without defaults", async t => {
  const f = await fixture(t);
  const incomplete = structuredClone(f.source);
  delete incomplete.operations[0].effect;
  assert.throws(() => parseSource(incomplete));
  const ledger = new Ledger(f.store);
  assert.throws(() => ledger.prepare(scope, "local", "notes", "append", {}, "binding"));
  assert.equal(ledger.list().length, 0);
});

test("ordinary preparation cannot restore a permission after service restart", async t => {
  const f = await fixture(t);
  const intent = await f.execution.prepare(scope, "local", "notes", "append", { file: join(f.root, "note"), note: "x" });
  const restarted = new ExecutionService(f.sources, f.store);
  await assert.rejects(restarted.execute(intent.id, scope, approveLocally));
  assert.equal(restarted.get(intent.id).attempt, undefined);
});

test("unknown ordinary changes block all subsequent changes but do not erase the source directory", async t => {
  const f = await fixture(t), file = join(f.root, "note");
  const intent = await f.execution.prepare(scope, "local", "notes", "append", { file, note: "x" });
  const ledger = new Ledger(f.store);
  ledger.start(intent.id); ledger.unknown(intent.id);
  await assert.rejects(f.execution.prepare({ ...scope, request: "next" }, "next", "notes", "append", { file, note: "y" }));
  assert.equal(f.sources.catalog()[0].operations.length, 1);
  await f.execution.resolve(intent.id, "Local file checked; no further send authorized", approveLocally);
  assert.equal((await f.execution.execute(intent.id, scope, approveLocally)).state, "closed");
  await assert.rejects(readFile(file));
});

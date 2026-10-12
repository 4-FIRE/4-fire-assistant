import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/storage/store.js";
import { ProviderConnections } from "../dist/integrations/provider-connections.js";
import { ProviderRegistry } from "../dist/services/provider-registry.js";
import { ExecutionService } from "../dist/services/execution-service.js";
import { Ledger } from "../dist/services/execution-ledger.js";
import { parseProvider, providerData } from "../dist/services/provider-config.js";
import { mergeCatalog, checkCatalogEdit } from "../dist/services/provider-catalog.js";
import { toolId } from "../dist/common/tool-id.js";
import { localConfirmation, approveLocally } from "./helpers/local-confirmation.mjs";

const scope = { session: "local", request: "one" };
const definition = { name: "manage", description: "Native operation", inputSchema: { type: "object" },
  outputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
const connection = { id: "catalog", kind: "mcp", url: "https://example.invalid/mcp", operations: [] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-permissions-"));
  await mkdir(join(root, ".ffa"));
  const store = new Store(join(root, ".ffa"));
  const providers = new ProviderRegistry(store, new ProviderConnections(root), () => execution.revoke(), root);
  const execution = new ExecutionService(providers, store);
  await providers.permissions.initialize();
  const operation = { name: "append", description: "Append JSON to a local file", inputSchema: { type: "object",
    additionalProperties: false, required: ["file", "note"], properties: { file: { type: "string" }, note: { type: "string" } } },
    argv: ["-a", { parameter: "file" }], stdin: true,
    outcomes: { accepted: { type: "object", required: ["file", "note"] }, rejected: { const: false } } };
  const provider = { id: "notes", kind: "cli", command: "/usr/bin/tee", coverage: { basis: "tee(1)", limitations: ["Only append is described"] }, operations: [operation] };
  store.put("provider", provider.id, providerData(parseProvider(provider)));
  t.after(async () => { await providers.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const config = join(root, ".ffa/permissions.json");
  const setPermission = permission => writeFile(config, JSON.stringify({ default: "ask", tools: { "notes/append": permission } }));
  return { root, store, providers, execution, provider, operation, config, setPermission };
}

test("catalog preserves all native definitions and availability without granting permission", () => {
  const first = mergeCatalog(parseProvider(connection), [definition, { ...definition, name: "other" }]);
  assert.equal(first.operations.length, 2);
  assert.deepEqual(first.operations[0].native, definition);
  assert.equal(first.discovery.status, "complete");
  const same = mergeCatalog(first, [definition, { ...definition, name: "other" }]);
  assert.deepEqual(providerData(same).operations, providerData(first).operations);
  const changed = mergeCatalog(same, [{ ...definition, description: "Changed contract" }]);
  assert.equal(changed.operations[0].description, "Changed contract");
  assert.equal(changed.operations.find(op => op.name === "other").available, false);
  const returned = mergeCatalog(changed, [definition, { ...definition, name: "other" }]);
  assert.ok(returned.operations.every(op => op.available === true));
  assert.throws(() => mergeCatalog(first, [definition, definition]));
});

test("catalog edits cannot invent discovery, omit tools or alter native definitions", () => {
  const discovered = mergeCatalog(parseProvider(connection), [definition, { ...definition, name: "other" }]);
  assert.throws(() => checkCatalogEdit(discovered, undefined));
  const edited = providerData(discovered); edited.operations.pop();
  assert.throws(() => checkCatalogEdit(parseProvider(edited), discovered));
  const altered = providerData(discovered); altered.operations[0].native.outputSchema = { type: "string" };
  assert.throws(() => checkCatalogEdit(parseProvider(altered), discovered));
  assert.throws(() => parseProvider({ ...connection, operations: [{ ...discovered.operations[0], unknownField: true }] }));
});

test("a real failed MCP process preserves its directory and rejects calls", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const mcp = parseProvider({ id: "failed", kind: "mcp", command: "/usr/bin/false", operations: [] });
  await f.providers.configure(providerData(mcp), approveLocally);
  const known = mergeCatalog(mcp, [definition]);
  f.store.put("provider", "failed", providerData(known));
  await assert.rejects(f.providers.discover("failed"));
  assert.equal(f.providers.provider("failed").discovery.status, "failed");
  assert.deepEqual(f.providers.provider("failed").operations, known.operations);
  await assert.rejects(f.execution.call(scope, "failed", "manage", {}, approveLocally));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.providers.discover("failed", cancelled.signal));
  assert.deepEqual(f.providers.provider("failed").operations, known.operations);
});

test("connection changes retain the old inventory as unavailable", async t => {
  const f = await fixture(t), known = mergeCatalog(parseProvider(connection), [definition]);
  f.store.put("provider", known.id, providerData(known));
  await f.providers.configure({ ...connection, url: "https://other.invalid/mcp" }, approveLocally);
  const next = f.providers.provider(known.id);
  assert.equal(next.operations.length, 1);
  assert.equal(next.operations[0].available, false);
  assert.equal(next.discovery.status, "stale");
});

test("tool IDs encode separators and keep provider identities distinct", () => {
  assert.equal(toolId("qmt", "submit_order"), "qmt/submit_order");
  assert.equal(toolId("qmt", "a/b%"), "qmt/a%2Fb%25");
  assert.notEqual(toolId("one", "a/b"), toolId("two", "a/b"));
});

test("connection setup adds initial rules only after approval and preserves user rules", async t => {
  const f = await fixture(t);
  await f.setPermission("deny");
  await f.providers.configure(f.provider, approveLocally, undefined, { "notes/append": "allow" });
  assert.equal(f.providers.permission("notes", "append"), "deny");
  const other = { ...f.provider, id: "other" };
  const confirmation = localConfirmation();
  const pending = f.providers.configure(other, confirmation.ask, undefined, { "other/append": "review" });
  const { dialog, value } = await confirmation.ready;
  assert.equal(value.operations[0].name, "append");
  assert.equal(f.providers.permission("other", "append"), "ask");
  dialog.handleInput("\t"); dialog.handleInput("\r");
  await pending;
  assert.equal(f.providers.permission("other", "append"), "review");
  assert.equal(f.providers.permission("notes", "append"), "deny");
  const rejected = { ...f.provider, id: "rejected" };
  const cancel = localConfirmation();
  const attempt = f.providers.configure(rejected, cancel.ask, undefined, { "rejected/append": "allow" });
  (await cancel.ready).dialog.handleInput("\r");
  await assert.rejects(attempt);
  assert.equal(f.providers.permissions.read().tools["rejected/append"], undefined);
  await assert.rejects(f.providers.configure(other, approveLocally, undefined, { "notes/append": "allow" }));
});

test("editing permissions during configuration rejects stale approval without overwriting the file", async t => {
  const f = await fixture(t), confirmation = localConfirmation();
  const pending = f.providers.configure(f.provider, confirmation.ask, undefined, { "notes/append": "allow" });
  const { dialog } = await confirmation.ready;
  await f.setPermission("deny");
  dialog.handleInput("\t"); dialog.handleInput("\r");
  await assert.rejects(pending);
  assert.equal(f.providers.permission("notes", "append"), "deny");
});

test("allow performs separate explicit calls without a confirmation channel", async t => {
  const f = await fixture(t), file = join(f.root, "allowed"), args = { file, note: "local" };
  await f.setPermission("allow");
  const first = await f.execution.call(scope, "notes", "append", args);
  const second = await f.execution.call(scope, "notes", "append", args);
  assert.equal(first.success, true); assert.notEqual(first.id, second.id);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args).repeat(2));
  assert.equal(f.store.list("intent").length, 2);
  assert.ok(f.store.list("intent").every(intent => intent.attempt && intent.receiptId));
});

test("default ask uses the real local confirmation and a prepared call sends at most once", async t => {
  const f = await fixture(t), file = join(f.root, "notes.json"), args = { file, note: "local" };
  const intent = await f.execution.prepare(scope, "Append note", "notes", "append", args);
  assert.equal(intent.permission, "ask");
  const confirmation = localConfirmation();
  const pending = f.execution.execute(intent.id, scope, confirmation.ask);
  const { dialog, value } = await confirmation.ready;
  assert.equal(value.permission, "ask");
  assert.equal(value.invocation.stdin, JSON.stringify(args));
  await assert.rejects(f.execution.execute(intent.id, scope, confirmation.ask));
  await assert.rejects(readFile(file));
  dialog.handleInput("\t"); dialog.handleInput("\r");
  const result = await pending;
  assert.equal(result.state, "observed"); assert.equal(result.outcome, "accepted");
  assert.ok(result.attempt); assert.ok(result.receiptId);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
  assert.equal((await f.execution.execute(intent.id, scope, confirmation.ask)).attempt.id, result.attempt.id);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args));
});

test("approval cancellation, revocation and permission or contract changes never send", async t => {
  const f = await fixture(t), file = join(f.root, "not-written");
  for (const action of ["decline", "abort", "revoke", "contract", "allow", "review", "deny", "other-rule", "invalid"]) {
    await f.setPermission("ask"); f.providers.permissions.read();
    const callScope = { ...scope, request: action }, signal = new AbortController();
    const intent = await f.execution.prepare(callScope, action, "notes", "append", { file, note: action });
    const confirmation = localConfirmation(signal.signal);
    const pending = f.execution.execute(intent.id, callScope, confirmation.ask, signal.signal);
    const { dialog } = await confirmation.ready;
    if (action === "decline") dialog.handleInput("\r");
    else if (action === "abort") signal.abort();
    else {
      if (action === "revoke") f.execution.revoke();
      else if (action === "contract") {
        const changed = providerData(f.providers.provider("notes")); changed.operations[0].description = "Changed contract";
        f.store.put("provider", "notes", changed);
      } else if (action === "invalid") await writeFile(f.config, "{");
      else if (action === "other-rule") await writeFile(f.config, JSON.stringify({ default: "ask", tools: { "other/tool": "deny" } }));
      else await f.setPermission(action);
      dialog.handleInput("\t"); dialog.handleInput("\r");
    }
    if (action === "decline") assert.equal((await pending).state, "declined");
    else await assert.rejects(pending);
    assert.equal(f.execution.get(intent.id).attempt, undefined);
    await assert.rejects(readFile(file));
  }
});

test("review requires current independent evidence and final user approval", async t => {
  const f = await fixture(t), file = join(f.root, "reviewed");
  const evidence = await f.execution.call(scope, "notes", "append", { file, note: "evidence" }, approveLocally);
  await f.setPermission("review");
  const intent = await f.execution.prepare(scope, "Append reviewed note", "notes", "append", { file, note: "reviewed" });
  await assert.rejects(f.execution.call(scope, "notes", "append", { file, note: "bypass" }, approveLocally));
  await assert.rejects(f.execution.execute(intent.id, scope, approveLocally));
  assert.throws(() => f.execution.review(intent.id, scope, f.execution.generation, "reviewer", true, [], "No evidence"));
  f.execution.review(intent.id, scope, f.execution.generation, "reviewer", true, [evidence.id], "Local file receipt");
  const confirmation = localConfirmation();
  const pending = f.execution.execute(intent.id, scope, confirmation.ask);
  const { dialog } = await confirmation.ready;
  assert.equal(await readFile(file, "utf8"), JSON.stringify(evidence.parameters));
  dialog.handleInput("\t"); dialog.handleInput("\r");
  assert.equal((await pending).state, "observed");
  assert.equal(await readFile(file, "utf8"), JSON.stringify(evidence.parameters) + JSON.stringify({ file, note: "reviewed" }));
});

test("denied and unavailable tools stay visible and cannot execute", async t => {
  const f = await fixture(t), args = { file: join(f.root, "note"), note: "local" };
  await f.setPermission("deny");
  assert.equal(f.providers.catalog()[0].operations[0].permission, "deny");
  await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  await assert.rejects(f.execution.prepare(scope, "local", "notes", "append", args));
  await f.setPermission("allow");
  f.store.put("provider", "notes", providerData(parseProvider({ ...f.provider, operations: [{ ...f.operation, available: false }] })));
  assert.equal(f.providers.catalog()[0].operations.length, 1);
  await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  await assert.rejects(readFile(args.file));
});

test("malformed, missing and symlinked permission files never fall back to allow", async t => {
  const f = await fixture(t), args = { file: join(f.root, "not-written"), note: "local" };
  for (const value of ["{", "null", '{}', '{"default":"unknown","tools":{}}', '{"default":"allow","tools":{"notes/append":"wrong"}}', '{"default":"allow","tools":{"notes/a/b":"allow"}}']) {
    await writeFile(f.config, value);
    await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  }
  await rm(f.config);
  await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  const other = join(f.root, "other.json");
  await writeFile(other, '{"default":"allow","tools":{}}'); await symlink(other, f.config);
  await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  await assert.rejects(readFile(args.file));
});

test("default changes apply to unconfigured tools; formatting does not revoke preparation", async t => {
  const f = await fixture(t), file = join(f.root, "default"), args = { file, note: "local" };
  const intent = await f.execution.prepare(scope, "local", "notes", "append", args);
  await writeFile(f.config, JSON.stringify({ tools: {}, default: "ask" }, null, 2));
  assert.equal((await f.execution.execute(intent.id, scope, approveLocally)).state, "observed");
  await writeFile(f.config, JSON.stringify({ default: "allow", tools: {} }));
  assert.equal((await f.execution.call(scope, "notes", "append", args)).success, true);
  await writeFile(f.config, JSON.stringify({ default: "deny", tools: {} }));
  await assert.rejects(f.execution.call(scope, "notes", "append", args));
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args).repeat(2));
});

test("unknown business results retain the real receipt and do not report an unsent call", async t => {
  const f = await fixture(t), file = join(f.root, "unknown"), args = { file, note: "local" };
  await f.setPermission("allow");
  const changed = providerData(f.providers.provider("notes"));
  changed.operations[0].outcomes = { accepted: { const: true }, rejected: { const: false } };
  f.store.put("provider", "notes", changed);
  await assert.rejects(f.execution.call(scope, "notes", "append", args));
  const [intent] = f.store.list("intent");
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt); assert.ok(intent.receiptId);
  assert.deepEqual(f.store.get("receipt", intent.receiptId).data, args);
  assert.equal(f.store.get("receipt", intent.receiptId).success, false);
  assert.equal((await f.execution.execute(intent.id, scope, approveLocally)).state, "unknown");
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args));
});

test("known rejected results return a failed receipt without an unknown obligation", async t => {
  const f = await fixture(t), file = join(f.root, "rejected"), args = { file, note: "local" };
  await f.setPermission("allow");
  const changed = providerData(f.providers.provider("notes"));
  changed.operations[0].outcomes = { accepted: { const: true }, rejected: { type: "object" } };
  f.store.put("provider", "notes", changed);
  const receipt = await f.execution.call(scope, "notes", "append", args);
  assert.equal(receipt.success, false); assert.deepEqual(receipt.data, args);
  assert.equal(f.store.list("intent")[0].outcome, "rejected");
  assert.equal(f.execution.unsettled().length, 0);
});

test("service restart cannot restore a prepared permission", async t => {
  const f = await fixture(t), intent = await f.execution.prepare(scope, "local", "notes", "append", { file: join(f.root, "note"), note: "x" });
  const restarted = new ExecutionService(f.providers, f.store);
  await assert.rejects(restarted.execute(intent.id, scope, approveLocally));
  assert.equal(restarted.get(intent.id).attempt, undefined);
});

test("unknown calls block review but allow approved checks and never authorize resends", async t => {
  const f = await fixture(t), file = join(f.root, "note");
  const intent = await f.execution.prepare(scope, "local", "notes", "append", { file, note: "x" });
  const ledger = new Ledger(f.store); ledger.start(intent.id); ledger.unknown(intent.id);
  await f.setPermission("review");
  await assert.rejects(f.execution.prepare({ ...scope, request: "next" }, "next", "notes", "append", { file, note: "y" }));
  await f.setPermission("ask");
  await f.execution.call(scope, "notes", "append", { file, note: "check" }, approveLocally);
  assert.equal(f.execution.get(intent.id).state, "unknown");
  await f.execution.resolve(intent.id, "Local file checked; no further send authorized", approveLocally);
  assert.equal((await f.execution.execute(intent.id, scope, approveLocally)).state, "closed");
  assert.equal(await readFile(file, "utf8"), JSON.stringify({ file, note: "check" }));
});

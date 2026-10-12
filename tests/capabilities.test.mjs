import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { watch } from "node:fs";
import { Store } from "../dist/storage/store.js";
import { ProviderConnections } from "../dist/integrations/provider-connections.js";
import { ProviderRegistry } from "../dist/services/provider-registry.js";
import { ExecutionService } from "../dist/services/execution-service.js";
import { Ledger } from "../dist/services/execution-ledger.js";
import { parseProvider, providerData } from "../dist/services/provider-config.js";
import { mergeCatalog, checkCatalogEdit } from "../dist/services/provider-catalog.js";
import { toolId } from "../dist/common/tool-id.js";
import { localConfirmation, approveLocally } from "./helpers/local-confirmation.mjs";

const scope = { session: "local" };
const definition = { name: "manage", description: "Native operation", inputSchema: { type: "object" },
  outputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
const connection = { id: "catalog", kind: "mcp", command: "/usr/bin/false", operations: [] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-permissions-"));
  await mkdir(join(root, ".ffa"));
  const store = new Store(join(root, ".ffa"));
  const providers = new ProviderRegistry(store, new ProviderConnections(root), root);
  const execution = new ExecutionService(providers, store);
  await providers.permissions.initialize();
  const operation = { name: "append", description: "Append JSON to a local file", inputSchema: { type: "object",
    additionalProperties: false, required: ["file", "note"], properties: { file: { type: "string" }, note: { type: "string" } } },
    argv: ["-a", { parameter: "file" }], stdin: true,
    outcomes: { accepted: { type: "object", required: ["file", "note"] }, rejected: { const: false } } };
  const provider = { id: "notes", kind: "cli", command: "/usr/bin/tee", coverage: { basis: "tee(1)", limitations: ["Only append is described"] }, operations: [operation] };
  store.put("provider", provider.id, providerData(parseProvider(provider)));
  t.after(async () => { await execution.close(); await providers.close(); store.close(); await rm(root, { recursive: true, force: true }); });
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

test("automatic discovery failure preserves the confirmed connection and old directory", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const result = await f.providers.configure(connection, approveLocally);
  assert.equal(result.configured, "catalog");
  assert.equal(result.providers[0].discovery.status, "failed");
  assert.equal(typeof result.discoveryError, "string");
  const known = mergeCatalog(parseProvider(connection), [definition]);
  f.store.put("provider", "catalog", providerData(known));
  await assert.rejects(f.providers.discover("catalog"));
  assert.equal(f.providers.provider("catalog").discovery.status, "failed");
  assert.deepEqual(f.providers.provider("catalog").operations, known.operations);
  await assert.rejects(f.execution.call(scope, "catalog", "manage", {}, approveLocally));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.providers.discover("catalog", cancelled.signal));
  assert.deepEqual(f.providers.provider("catalog").operations, known.operations);
});

test("changed MCP connection retains old tools as unavailable after automatic discovery fails", async t => {
  const f = await fixture(t), known = mergeCatalog(parseProvider(connection), [definition]);
  f.store.put("provider", known.id, providerData(known));
  const result = await f.providers.configure({ ...connection, args: ["changed"] }, approveLocally);
  assert.equal(result.providers[0].discovery.status, "failed");
  const next = f.providers.provider(known.id);
  assert.equal(next.operations.length, 1);
  assert.equal(next.operations[0].available, false);
  assert.deepEqual(next.args, ["changed"]);
});

test("tool IDs encode separators and keep provider identities distinct", () => {
  assert.equal(toolId("qmt", "submit_order"), "qmt/submit_order");
  assert.equal(toolId("qmt", "a/b%"), "qmt/a%2Fb%25");
  assert.notEqual(toolId("one", "a/b"), toolId("two", "a/b"));
});

test("configuration adds initial rules after approval and preserves user rules", async t => {
  const f = await fixture(t);
  await f.setPermission("deny");
  await f.providers.configure(f.provider, approveLocally, undefined, { "notes/append": "allow" });
  assert.equal(f.providers.permission("notes", "append"), "deny");
  const other = { ...f.provider, id: "other" }, confirmation = localConfirmation();
  const pending = f.providers.configure(other, confirmation.ask, undefined, { "other/append": "review" });
  const { dialog, value } = await confirmation.ready;
  assert.equal(value.operations[0].name, "append");
  assert.equal(f.providers.permission("other", "append"), "ask");
  dialog.handleInput("\t"); dialog.handleInput("\r"); await pending;
  assert.equal(f.providers.permission("other", "append"), "review");
  assert.equal(f.providers.permission("notes", "append"), "deny");
  const rejected = { ...f.provider, id: "rejected" }, cancel = localConfirmation();
  const attempt = f.providers.configure(rejected, cancel.ask, undefined, { "rejected/append": "allow" });
  (await cancel.ready).dialog.handleInput("\r"); await assert.rejects(attempt);
  assert.equal(f.providers.permissions.read().tools["rejected/append"], undefined);
  await assert.rejects(f.providers.configure(other, approveLocally, undefined, { "notes/append": "allow" }));
});

test("ID-only permissions use the registered directory and retain connection and existing rules", async t => {
  const f = await fixture(t);
  const before = providerData(f.providers.provider("notes"));
  const confirmation = localConfirmation();
  const pending = f.providers.configure("notes", confirmation.ask, undefined, { "notes/append": "review" });
  const { dialog } = await confirmation.ready;
  assert.equal(f.providers.permissions.read().tools["notes/append"], undefined);
  dialog.handleInput("\t"); dialog.handleInput("\r"); await pending;
  assert.deepEqual(providerData(f.providers.provider("notes")), before);
  assert.equal(f.providers.permission("notes", "append"), "review");
  await f.providers.configure("notes", approveLocally, undefined, { "notes/append": "allow" });
  assert.equal(f.providers.permission("notes", "append"), "review");
  await assert.rejects(f.providers.configure("notes", approveLocally, undefined, { "other/append": "allow" }));
});

test("configuration rejects changed permissions or directory during confirmation", async t => {
  const f = await fixture(t);
  for (const action of ["permissions", "directory"]) {
    await writeFile(f.config, '{"default":"ask","tools":{}}');
    const confirmation = localConfirmation();
    const pending = f.providers.configure("notes", confirmation.ask, undefined, { "notes/append": "allow" });
    const { dialog } = await confirmation.ready;
    if (action === "permissions") await f.setPermission("deny");
    else {
      const changed = providerData(f.providers.provider("notes")); changed.operations[0].description = "Changed";
      f.store.put("provider", "notes", changed);
    }
    dialog.handleInput("\t"); dialog.handleInput("\r"); await assert.rejects(pending);
    assert.notEqual(f.providers.permissions.read().tools["notes/append"], "allow");
  }
});

test("allow performs separate explicit calls without a confirmation channel", async t => {
  const f = await fixture(t), file = join(f.root, "allowed"), args = { file, note: "local" };
  await f.setPermission("allow");
  const first = await f.execution.call(scope, "notes", "append", args);
  const second = await f.execution.call(scope, "notes", "append", args);
  assert.equal(first.outcome, "accepted"); assert.notEqual(first.id, second.id);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args).repeat(2));
  assert.ok(f.store.list("intent").every(intent => intent.attempt && intent.receiptId));
});

for (const permission of ["ask", "review"]) {
  test(permission + " requires only this call's real user confirmation", async t => {
    const f = await fixture(t), file = join(f.root, "note"), args = { file, note: permission };
    await f.setPermission(permission);
    const confirmation = localConfirmation();
    const pending = f.execution.call(scope, "notes", "append", args, confirmation.ask);
    const { dialog, value } = await confirmation.ready;
    assert.equal(value.permission, permission);
    assert.equal(value.invocation.stdin, JSON.stringify(args));
    assert.equal(f.execution.get(value.intentId).state, "pending");
    assert.equal(f.execution.get(value.intentId).attempt, undefined);
    await assert.rejects(readFile(file));
    dialog.handleInput("\t"); dialog.handleInput("\r");
    const result = await pending;
    assert.equal(result.state, "observed"); assert.equal(result.outcome, "accepted");
    assert.ok(result.attempt); assert.ok(result.receiptId);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
    assert.throws(() => new Ledger(f.store).start(result.id));
  });
}

test("decline, cancellation and permission, credential or contract changes never send", async t => {
  const f = await fixture(t), file = join(f.root, "not-written");
  for (const action of ["decline", "abort", "contract", "allow", "review", "deny", "other-rule", "invalid", "credential"]) {
    await f.setPermission("ask");
    const signal = new AbortController(), confirmation = localConfirmation(signal.signal);
    const pending = f.execution.call(scope, "notes", "append", { file, note: action }, confirmation.ask, signal.signal);
    const { dialog, value } = await confirmation.ready;
    if (action === "decline") dialog.handleInput("\r");
    else if (action === "abort") signal.abort();
    else {
      if (action === "contract") {
        const changed = providerData(f.providers.provider("notes")); changed.operations[0].description = "Changed contract";
        f.store.put("provider", "notes", changed);
      } else if (action === "invalid") await writeFile(f.config, "{");
      else if (action === "other-rule") await writeFile(f.config, JSON.stringify({ default: "ask", tools: { "other/tool": "deny" } }));
      else if (action === "credential") {
        const changed = providerData(f.providers.provider("notes")); changed.env = { LOCAL_TEST: "${FFA_TEST_VALUE}" };
        f.store.put("provider", "notes", changed);
      } else await f.setPermission(action);
      dialog.handleInput("\t"); dialog.handleInput("\r");
    }
    if (action === "decline") assert.equal((await pending).state, "declined");
    else await assert.rejects(pending);
    assert.equal(f.execution.get(value.intentId).attempt, undefined);
    assert.equal(f.execution.get(value.intentId).state, "declined");
    await assert.rejects(readFile(file));
  }
});

test("denied and unavailable tools stay visible and cannot execute", async t => {
  const f = await fixture(t), args = { file: join(f.root, "note"), note: "local" };
  await f.setPermission("deny");
  assert.equal(f.providers.catalog()[0].operations[0].permission, "deny");
  await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  await f.setPermission("allow");
  f.store.put("provider", "notes", providerData(parseProvider({ ...f.provider, operations: [{ ...f.operation, available: false }] })));
  assert.equal(f.providers.catalog()[0].operations.length, 1);
  await assert.rejects(f.execution.call(scope, "notes", "append", args, approveLocally));
  await assert.rejects(readFile(args.file));
});

test("malformed, missing and symlinked permissions never fall back to allow", async t => {
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

test("default changes apply to unconfigured tools and formatting does not invalidate confirmation", async t => {
  const f = await fixture(t), file = join(f.root, "default"), args = { file, note: "local" }, confirmation = localConfirmation();
  const pending = f.execution.call(scope, "notes", "append", args, confirmation.ask);
  const { dialog } = await confirmation.ready;
  await writeFile(f.config, JSON.stringify({ tools: {}, default: "ask" }, null, 2));
  dialog.handleInput("\t"); dialog.handleInput("\r"); assert.equal((await pending).state, "observed");
  await writeFile(f.config, JSON.stringify({ default: "allow", tools: {} }));
  assert.equal((await f.execution.call(scope, "notes", "append", args)).outcome, "accepted");
  await writeFile(f.config, JSON.stringify({ default: "deny", tools: {} }));
  await assert.rejects(f.execution.call(scope, "notes", "append", args));
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args).repeat(2));
});

test("unknown business results retain receipts and do not block later approved review calls", async t => {
  const f = await fixture(t), file = join(f.root, "unknown"), args = { file, note: "local" };
  await f.setPermission("allow");
  const changed = providerData(f.providers.provider("notes"));
  changed.operations[0].outcomes = { accepted: { const: true }, rejected: { const: false } };
  f.store.put("provider", "notes", changed);
  const intent = await f.execution.call(scope, "notes", "append", args);
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt); assert.ok(intent.receiptId);
  assert.deepEqual(f.store.get("receipt", intent.receiptId).data, args);
  assert.equal(f.store.get("receipt", intent.receiptId).success, false);
  f.store.put("provider", "notes", providerData(parseProvider(f.provider)));
  await f.setPermission("review");
  const next = await f.execution.call(scope, "notes", "append", { file, note: "approved new call" }, approveLocally);
  assert.equal(next.state, "observed"); assert.equal(f.execution.get(intent.id).state, "unknown");
  await f.execution.resolve(intent.id, "Checked local file; no resend authorized", approveLocally);
  assert.equal(f.execution.get(intent.id).state, "closed");
  assert.throws(() => new Ledger(f.store).start(intent.id));
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args) + JSON.stringify(next.parameters));
});

test("known rejected business results keep failed receipts without an unknown obligation", async t => {
  const f = await fixture(t), file = join(f.root, "rejected"), args = { file, note: "local" };
  await f.setPermission("allow");
  const changed = providerData(f.providers.provider("notes"));
  changed.operations[0].outcomes = { accepted: { const: true }, rejected: { type: "object" } };
  f.store.put("provider", "notes", changed);
  const intent = await f.execution.call(scope, "notes", "append", args);
  const receipt = f.store.get("receipt", intent.receiptId);
  assert.equal(receipt.success, false); assert.deepEqual(receipt.data, args);
  assert.equal(intent.state, "observed"); assert.equal(intent.outcome, "rejected");
  assert.equal(f.execution.unsettled().length, 0);
});

test("real process failure returns an unknown record with the protocol output", async t => {
  const f = await fixture(t);
  await f.providers.configure({ id: "failure", kind: "cli", command: "/usr/bin/false",
    coverage: { basis: "false(1)", limitations: [] },
    operations: [{ name: "exit", description: "Exit nonzero", inputSchema: { type: "object", additionalProperties: false }, argv: [] }] },
    approveLocally, undefined, { "failure/exit": "allow" });
  const intent = await f.execution.call(scope, "failure", "exit", {});
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt); assert.ok(intent.receiptId);
  assert.equal(f.store.get("receipt", intent.receiptId).data.exitCode, 1);
  assert.equal(f.execution.unsettled().length, 1);
});

test("cancellation after a real file write retains an unknown attempt and never repeats it", { timeout: 15_000 }, async t => {
  const f = await fixture(t), file = join(f.root, "written"), controller = new AbortController();
  const code = "import json,sys,time\nfrom pathlib import Path\np=json.load(sys.stdin)\nPath(p['file']).write_text(json.dumps(p))\ntime.sleep(60)";
  await f.providers.configure({ id: "process", kind: "cli", command: "/usr/bin/python3",
    coverage: { basis: "Local Python file calculation", limitations: [] },
    operations: [{ name: "write", description: "Write local input and wait", inputSchema: { type: "object" }, argv: ["-c", code], stdin: true }] },
    approveLocally, undefined, { "process/write": "allow" });
  const watcher = watch(f.root, (_event, path) => { if (path === "written") controller.abort(); });
  t.after(() => watcher.close());
  const args = { file, note: "sent once" };
  const intent = await f.execution.call(scope, "process", "write", args, undefined, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
  assert.equal(f.store.list("intent").length, 1);
  assert.throws(() => new Ledger(f.store).start(intent.id));
});

test("receipt storage failure leaves a recoverable attempt and stops new sends", async t => {
  const f = await fixture(t), file = join(f.root, "saved-once"), args = { file, note: "local" };
  await f.setPermission("allow");
  const db = new DatabaseSync(join(f.root, ".ffa/business.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON records WHEN NEW.kind='receipt' BEGIN SELECT RAISE(ABORT, 'local disk write rejected'); END");
    await assert.rejects(f.execution.call(scope, "notes", "append", args));
    const [intent] = f.store.list("intent");
    assert.equal(intent.state, "dispatched"); assert.ok(intent.attempt);
    assert.equal(f.store.list("receipt").length, 0);
    await assert.rejects(f.execution.call(scope, "notes", "append", args));
    assert.equal(await readFile(file, "utf8"), JSON.stringify(args));
    await f.execution.close(); await f.providers.close(); f.store.close();
    const reopened = new Store(join(f.root, ".ffa"), false);
    try { const ledger = new Ledger(reopened); ledger.recover(); assert.equal(ledger.get(intent.id).state, "unknown"); }
    finally { reopened.close(); }
  } finally { db.close(); }
});

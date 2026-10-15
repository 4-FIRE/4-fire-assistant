import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watch } from "node:fs";
import { Store } from "../../dist/storage/store.js";
import { ProviderConnections } from "../../dist/integrations/providers/provider-connections.js";
import { ProviderRegistry } from "../../dist/services/providers/provider-registry.js";
import { ExecutionService } from "../../dist/services/execution/execution-service.js";
import { Ledger } from "../../dist/services/execution/execution-ledger.js";
import { parseProvider, providerData } from "../../dist/storage/provider-config.js";
import { mergeCatalog } from "../../dist/services/providers/provider-catalog.js";
import { toolId } from "../../dist/common/tool-id.js";
import { localConfirmation, approveLocally } from "../helpers/local-confirmation.mjs";

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
  const provider = { id: "notes", kind: "cli", command: "tee", coverage: { basis: "tee(1)", limitations: ["Only append is described"] }, operations: [operation] };
  store.providers.save(provider.id, providerData(parseProvider(provider)));
  t.after(async () => { await execution.close(); await providers.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const config = join(root, ".ffa/permissions.json");
  const setPermission = permission => writeFile(config, JSON.stringify({ default: "ask", tools: { "notes/append": permission } }));
  return { root, store, providers, execution, provider, operation, config, setPermission };
}

test("CLI command names persist unchanged and execute through each workspace's host PATH", async t => {
  const first = await fixture(t), second = await fixture(t), originalPath = process.env.PATH;
  t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
  const provider = { id: "portable", kind: "cli", command: "local-printf",
    coverage: { basis: "printf(1)", limitations: [] },
    operations: [{ name: "print", description: "Print JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] }] };
  for (const f of [first, second]) {
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await symlink("/usr/bin/printf", join(bin, "local-printf"));
    process.env.PATH = bin + ":/usr/bin:/bin";
    await f.providers.manage({ action: "register", provider: provider.id, config: { kind: "cli", command: provider.command },
      coverage: provider.coverage, operations: provider.operations, permissions: { print: "allow" } }, approveLocally);
    assert.equal(f.store.providers.get("portable").command, "local-printf");
    assert.equal(f.providers.preview("portable", "print", {}).command, "local-printf");
    const result = await f.execution.call(scope, "portable", "print", { value: 42 });
    assert.deepEqual(result.data, { value: 42 });
    assert.deepEqual(JSON.parse(await readFile(f.store.calls.receipt(result.receiptId).dataPath, "utf8")).data, { value: 42 });
  }
});

test("CLI sends the approved argv and stdin after the caller changes its input object", async t => {
  const f = await fixture(t);
  const code = "import json,sys\nprint(json.dumps({'argv':sys.argv[1:],'stdin':sys.stdin.read()}))";
  const provider = { id: "arguments", kind: "cli", command: "python3",
    coverage: { basis: "Local Python argument and input inspection", limitations: [] },
    operations: [{ name: "inspect", description: "Return process arguments and stdin", inputSchema: { type: "object" },
      argv: ["-c", code, "literal", { parameter: "text" }, { parameter: "count" }, { parameter: "enabled" }, { json: true }], stdin: true }] };
  f.store.providers.save(provider.id, providerData(parseProvider(provider)));
  const parameters = { count: 42.5, enabled: false, nested: { values: [null, "值"] }, text: "换行\n$(echo unsafe); & | >" };
  const approved = structuredClone(parameters), serialized = JSON.stringify(approved), confirmation = localConfirmation();
  const pending = f.execution.call(scope, provider.id, "inspect", parameters, confirmation.ask);
  const { dialog, value } = await confirmation.ready;
  const argv = ["literal", approved.text, "42.5", "false", serialized];
  assert.deepEqual(value.invocation, { provider: provider.id, command: "python3", argv: ["-c", code, ...argv], stdin: serialized });
  parameters.text = "changed";
  parameters.nested.values.push("changed");
  dialog.handleInput("\r");
  const result = await pending;
  assert.equal(result.state, "observed");
  assert.deepEqual(result.data, { argv, stdin: serialized });
  assert.deepEqual(f.store.calls.receipt(result.receiptId).parameters, approved);
});

test("CLI changes to PATH, executable target or availability during approval never send", async t => {
  for (const change of ["path", "target", "remove"]) {
    await t.test(change, async t => {
      const f = await fixture(t), originalPath = process.env.PATH, bin = join(f.root, "bin");
      t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
      await mkdir(bin);
      const executable = join(bin, "local-printf");
      await symlink("/usr/bin/printf", executable);
      process.env.PATH = bin + ":/usr/bin:/bin";
      await f.providers.manage({ action: "register", provider: "portable", config: { kind: "cli", command: "local-printf" },
        coverage: { basis: "printf(1)", limitations: [] },
        operations: [{ name: "print", description: "Print JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }] }] },
      approveLocally);
      const confirmation = localConfirmation(), pending = f.execution.call(scope, "portable", "print", {}, confirmation.ask);
      const rejected = assert.rejects(pending);
      const { dialog, value } = await confirmation.ready;
      if (change === "path") process.env.PATH += ":/additional-directory";
      else {
        await rm(executable);
        if (change === "target") await symlink("/usr/bin/tee", executable);
      }
      dialog.handleInput("\r");
      await rejected;
      assert.equal(f.execution.get(value.intentId).attempt, undefined);
      assert.equal(f.store.calls.list().flatMap(record => record.receipt ? [record.receipt] : []).length, 0);
    });
  }
});

test("missing and non-executable CLI commands cannot register; stored absolute commands cannot send", async t => {
  const f = await fixture(t), originalPath = process.env.PATH, bin = join(f.root, "bin");
  t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
  await mkdir(bin);
  process.env.PATH = bin;
  const provider = { id: "blocked", kind: "cli", command: "not-installed", coverage: { basis: "Local availability check", limitations: [] },
    operations: [{ name: "run", description: "", inputSchema: { type: "object", additionalProperties: false }, argv: [] }] };
  const request = { action: "register", provider: provider.id, config: { kind: "cli", command: provider.command }, coverage: provider.coverage, operations: provider.operations };
  assert.equal((await f.providers.manage(request, approveLocally)).error.category, "connection");
  await writeFile(join(bin, "not-executable"), "not executable", { mode: 0o600 });
  assert.equal((await f.providers.manage({ ...request, config: { kind: "cli", command: "not-executable" } }, approveLocally)).error.category, "connection");
  assert.equal(f.store.providers.get("blocked"), undefined);
  assert.throws(() => f.store.providers.save("notes", { ...f.provider, command: "/usr/bin/tee" }));
  await writeFile(join(f.root, ".ffa/providers/notes/config.json"), JSON.stringify({ kind: "cli", command: "/usr/bin/tee" }));
  await assert.rejects(f.execution.call(scope, "notes", "append", { file: join(f.root, "unsent"), note: "local" }, approveLocally));
  assert.throws(() => f.store.providers.get("notes"));
  assert.equal(f.store.calls.list().map(record => record.intent).length, 0);
});

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

test("MCP previews use the stored catalog without connecting and return independent parameters", async t => {
  const f = await fixture(t), marker = join(f.root, "connected");
  // This real command would create the marker if started; it implements no MCP service.
  const provider = mergeCatalog(parseProvider({ ...connection, command: "/usr/bin/touch", args: [marker] }), [definition]);
  f.store.providers.save(provider.id, providerData(provider));
  const parameters = { nested: { values: ["original"] } };
  const preview = f.providers.preview(provider.id, definition.name, parameters);
  assert.deepEqual(preview, { provider: provider.id, server: "/usr/bin/touch", args: [marker], tool: definition.name, parameters });
  preview.parameters.nested.values.push("changed");
  assert.deepEqual(parameters, { nested: { values: ["original"] } });
  await f.providers.close();
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual(f.store.calls.list(), []);
});

test("automatic discovery failure preserves the confirmed connection and old directory", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const result = await f.providers.manage({ action: "register", provider: "catalog", config: { kind: "mcp", command: "/usr/bin/false" } }, approveLocally);
  assert.equal(result.configSaved, true);
  assert.equal(result.discovery.status, "failed");
  assert.equal(result.error.category, "discovery");
  const known = mergeCatalog(parseProvider(connection), [definition]);
  f.store.providers.save("catalog", providerData(known));
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
  f.store.providers.save(known.id, providerData(known));
  const read = f.providers.readManagement({ action: "read", provider: "catalog", target: "connection" });
  const result = await f.providers.manage({ action: "update", provider: "catalog", target: "connection", expectedRevision: read.revision,
    config: { ...read.config, args: ["changed"] } }, approveLocally);
  assert.equal(result.discovery.status, "failed");
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

test("allow performs separate explicit calls without a confirmation channel", async t => {
  const f = await fixture(t), file = join(f.root, "allowed"), args = { file, note: "local" };
  await f.setPermission("allow");
  const first = await f.execution.call(scope, "notes", "append", args);
  const second = await f.execution.call(scope, "notes", "append", args);
  assert.equal(first.outcome, "accepted"); assert.notEqual(first.id, second.id);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args).repeat(2));
  assert.ok(f.store.calls.list().map(record => record.intent).every(intent => intent.attempt && intent.receiptId));
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
    dialog.handleInput("\r");
    const result = await pending;
    assert.equal(result.state, "observed"); assert.equal(result.outcome, "accepted");
    assert.ok(result.attempt); assert.ok(result.receiptId);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
    assert.throws(() => new Ledger(f.store.calls).start(result.id));
  });
}

test("decline, cancellation and permission, credential or contract changes never send", async t => {
  const f = await fixture(t), file = join(f.root, "not-written");
  for (const action of ["decline", "abort", "contract", "allow", "review", "deny", "other-rule", "invalid", "credential"]) {
    await f.setPermission("ask");
    const signal = new AbortController(), confirmation = localConfirmation(signal.signal);
    const pending = f.execution.call(scope, "notes", "append", { file, note: action }, confirmation.ask, signal.signal);
    const { dialog, value } = await confirmation.ready;
    if (action === "decline") { dialog.handleInput("\t"); dialog.handleInput("\r"); }
    else if (action === "abort") signal.abort();
    else {
      if (action === "contract") {
        const changed = providerData(f.providers.provider("notes")); changed.operations[0].description = "Changed contract";
        f.store.providers.save("notes", changed);
      } else if (action === "invalid") await writeFile(f.config, "{");
      else if (action === "other-rule") await writeFile(f.config, JSON.stringify({ default: "ask", tools: { "other/tool": "deny" } }));
      else if (action === "credential") {
        const changed = providerData(f.providers.provider("notes")); changed.env = { LOCAL_TEST: "${FFA_TEST_VALUE}" };
        f.store.providers.save("notes", changed);
      } else await f.setPermission(action);
      dialog.handleInput("\r");
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
  f.store.providers.save("notes", providerData(parseProvider({ ...f.provider, operations: [{ ...f.operation, available: false }] })));
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
  dialog.handleInput("\r"); assert.equal((await pending).state, "observed");
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
  f.store.providers.save("notes", changed);
  const intent = await f.execution.call(scope, "notes", "append", args);
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt); assert.ok(intent.receiptId);
  assert.deepEqual(JSON.parse(await readFile(f.store.calls.receipt(intent.receiptId).dataPath, "utf8")).data, args);
  assert.equal(f.store.calls.receipt(intent.receiptId).success, false);
  f.store.providers.save("notes", providerData(parseProvider(f.provider)));
  await f.setPermission("review");
  const next = await f.execution.call(scope, "notes", "append", { file, note: "approved new call" }, approveLocally);
  assert.equal(next.state, "observed"); assert.equal(f.execution.get(intent.id).state, "unknown");
  assert.equal(f.execution.get(intent.id).state, "unknown");
  assert.throws(() => new Ledger(f.store.calls).start(intent.id));
  assert.equal(await readFile(file, "utf8"), JSON.stringify(args) + JSON.stringify(next.parameters));
});

test("known rejected business results keep failed receipts without an unknown obligation", async t => {
  const f = await fixture(t), file = join(f.root, "rejected"), args = { file, note: "local" };
  await f.setPermission("allow");
  const changed = providerData(f.providers.provider("notes"));
  changed.operations[0].outcomes = { accepted: { const: true }, rejected: { type: "object" } };
  f.store.providers.save("notes", changed);
  const intent = await f.execution.call(scope, "notes", "append", args);
  const receipt = f.store.calls.receipt(intent.receiptId);
  assert.equal(receipt.success, false); assert.deepEqual(JSON.parse(await readFile(receipt.dataPath, "utf8")).data, args);
  assert.equal(intent.state, "observed"); assert.equal(intent.outcome, "rejected");
  assert.equal(f.execution.unknownCalls().length, 0);
});

test("real process failure returns an unknown record with the protocol output", async t => {
  const f = await fixture(t);
  await f.providers.manage({ action: "register", provider: "failure", config: { kind: "cli", command: "false" },
    coverage: { basis: "false(1)", limitations: [] },
    operations: [{ name: "exit", description: "Exit nonzero", inputSchema: { type: "object", additionalProperties: false }, argv: [] }],
    permissions: { exit: "allow" } }, approveLocally);
  const intent = await f.execution.call(scope, "failure", "exit", {});
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt); assert.ok(intent.receiptId);
  assert.equal(JSON.parse(await readFile(f.store.calls.receipt(intent.receiptId).dataPath, "utf8")).data.exitCode, 1);
  assert.equal(f.execution.unknownCalls().length, 1);
});

test("cancellation after a real file write retains an unknown attempt and never repeats it", { timeout: 15_000 }, async t => {
  const f = await fixture(t), file = join(f.root, "written"), controller = new AbortController();
  const code = "import json,sys,time\nfrom pathlib import Path\np=json.load(sys.stdin)\nPath(p['file']).write_text(json.dumps(p))\ntime.sleep(60)";
  await f.providers.manage({ action: "register", provider: "process", config: { kind: "cli", command: "python3" },
    coverage: { basis: "Local Python file calculation", limitations: [] },
    operations: [{ name: "write", description: "Write local input and wait", inputSchema: { type: "object" }, argv: ["-c", code], stdin: true }],
    permissions: { write: "allow" } }, approveLocally);
  const watcher = watch(f.root, (_event, path) => { if (path === "written") controller.abort(); });
  t.after(() => watcher.close());
  const args = { file, note: "sent once" };
  const intent = await f.execution.call(scope, "process", "write", args, undefined, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.equal(intent.state, "unknown"); assert.ok(intent.attempt);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), args);
  assert.equal(f.store.calls.list().map(record => record.intent).length, 1);
  assert.throws(() => new Ledger(f.store.calls).start(intent.id));
});

for (const folder of ["calls", "results"]) test(folder + " write failure leaves a recoverable attempt and stops new sends", async t => {
  if (process.getuid?.() === 0) return t.skip("Requires OS permission enforcement");
  const f = await fixture(t), file = join(f.root, "saved-once"), args = { file, note: "local" };
  const calls = join(f.root, ".ffa", folder);
  const code = "import json,sys,os\nfrom pathlib import Path\np=json.load(sys.stdin)\nPath(p['file']).write_text(json.dumps(p,separators=(',',':')))\nos.chmod(" + JSON.stringify(calls) + ",0o500)\nprint(json.dumps(p))";
  f.store.providers.save("notes", { ...f.provider, command: "python3", operations: [{ ...f.operation, argv: ["-c", code] }] });
  await f.setPermission("allow");
  try {
    await assert.rejects(f.execution.call(scope, "notes", "append", args));
    const [intent] = f.store.calls.list().map(record => record.intent);
    assert.equal(intent.state, "dispatched"); assert.ok(intent.attempt);
    assert.equal(f.store.calls.list().flatMap(record => record.receipt ? [record.receipt] : []).length, 0);
    const results = await readdir(join(f.root, ".ffa/results"));
    assert.equal(results.length, folder === "calls" ? 1 : 0);
    if (results.length) {
      assert.equal(results[0], intent.id + ".json");
      assert.deepEqual(JSON.parse(await readFile(join(f.root, ".ffa/results", results[0]), "utf8")).data, args);
    }
    await assert.rejects(f.execution.call(scope, "notes", "append", args));
    assert.equal(await readFile(file, "utf8"), JSON.stringify(args));
    await chmod(calls, 0o700);
    await f.execution.close(); await f.providers.close(); f.store.close();
    const reopened = new Store(join(f.root, ".ffa"), false);
    try { const ledger = new Ledger(reopened.calls); ledger.recover(); assert.equal(ledger.get(intent.id).state, "unknown"); }
    finally { reopened.close(); }
  } finally { await chmod(calls, 0o700); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { ProviderConnections } from "../dist/integrations/provider-connections.js";
import { ProviderRegistry } from "../dist/services/provider-registry.js";
import { ExecutionService } from "../dist/services/execution-service.js";
import { schema } from "../dist/common/validation.js";
import { providerData, parseProvider } from "../dist/services/provider-config.js";
import { mergeCatalog } from "../dist/services/provider-catalog.js";
import { validateManagement } from "../dist/tools/provider-manage.js";
import { managementInput, managementOutput } from "../dist/tools/schemas/provider-management.js";
import { approveLocally, localConfirmation } from "./helpers/local-confirmation.mjs";

const definition = { name: "echo", description: "Echo JSON", inputSchema: { type: "object" }, argv: [], stdin: true };
const registration = { action: "register", provider: "local", config: { kind: "cli", command: "cat" },
  coverage: { basis: "cat(1)", limitations: [] }, operations: [definition] };
const validOutput = schema(managementOutput);
async function fixture(t, register = true) {
  const root = await mkdtemp(join(tmpdir(), "ffa-management-"));
  await mkdir(join(root, ".ffa"));
  const store = new Store(join(root, ".ffa"));
  const providers = new ProviderRegistry(store, new ProviderConnections(root), root);
  const execution = new ExecutionService(providers, store);
  t.after(async () => { await execution.close(); await providers.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const run = async request => {
    validateManagement(request);
    const result = await providers.manage(request, approveLocally);
    assert.ok(validOutput(result), JSON.stringify(validOutput.errors));
    return result;
  };
  const read = (target, extra = {}) => providers.readManagement({ action: "read", provider: "local", target, ...extra });
  if (register) assert.equal((await run(registration)).configSaved, true);
  return { root, store, providers, execution, run, read };
}

test("management schemas reject state echoing, ambiguous branches and incomplete CLI bindings", () => {
  validateManagement(registration);
  const invalid = [
    { ...registration, config: { ...registration.config, discovery: {} } },
    { ...registration, config: { ...registration.config, args: [] } },
    { ...registration, operations: [{ ...definition, native: {} }] },
    { ...registration, operations: [{ ...definition, argv: undefined }] },
    { ...registration, config: { kind: "mcp", command: "/usr/bin/false" } },
    { action: "register", provider: "mcp", config: { kind: "mcp", url: "http://localhost", env: {} } },
    { action: "discover", provider: "local", permissions: {} },
    { action: "read", provider: "local", target: "outcomes" },
    { action: "update", provider: "local", target: "permissions", mode: "suggest", expectedRevision: "x", permissions: { echo: null } },
    { action: "update", provider: "local", target: "operations", replace: [{ expectedRevision: "x", definition: { ...definition, outcomes: { accepted: {}, rejected: {} } } }] },
  ];
  for (const request of invalid) {
    assert.equal(schema(managementInput)(request), false);
    assert.throws(() => validateManagement(request));
  }
});

test("registration and editable reads preserve defaults, versions and explicit empty argv", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.providers.permissions.read(), { default: "ask", tools: {} });
  for (const target of ["connection", "operations", "coverage", "permissions", "outcomes"]) {
    const request = { action: "read", provider: "local", target, ...(target === "outcomes" ? { operation: "echo" } : {}) };
    const read = await f.run(request);
    assert.deepEqual(await f.run(request), read);
  }
  await assert.rejects(f.run(registration));
  const rules = f.read("permissions");
  await f.run({ action: "update", provider: "local", target: "permissions", expectedRevision: rules.revision, mode: "set", permissions: { echo: "allow" } });
  const call = await f.execution.call({ session: "local" }, "local", "echo", { exact: [1, "a"] });
  assert.deepEqual(call.observation.data, { exact: [1, "a"] });
  assert.deepEqual(f.providers.operation("local", "echo").argv, []);
});

test("incremental edits preserve unrelated operations and use per-object revisions", async t => {
  const f = await fixture(t);
  const echo = f.read("operations").operations[0];
  await f.run({ action: "update", provider: "local", target: "operations", add: [{ ...definition, name: "other" }] });
  const other = f.read("operations", { operation: "other" }).operations[0];
  const first = await f.run({ action: "update", provider: "local", target: "operations", replace: [
    { expectedRevision: echo.revision, definition: { ...echo.definition, description: "Updated" } },
  ] });
  assert.equal(first.configSaved, true);
  const second = await f.run({ action: "update", provider: "local", target: "operations", replace: [
    { expectedRevision: other.revision, definition: { ...other.definition, description: "Other updated" } },
  ] });
  assert.equal(second.configSaved, true);
  assert.equal(f.providers.operation("local", "echo").description, "Updated");
  const stale = await f.run({ action: "update", provider: "local", target: "operations", replace: [
    { expectedRevision: echo.revision, definition: echo.definition },
  ] });
  assert.equal(stale.error.category, "conflict");
  const current = f.read("operations", { operation: "echo" }).operations[0];
  await f.run({ action: "update", provider: "local", target: "operations", replace: [{ expectedRevision: current.revision, definition: echo.definition }] });
  assert.notEqual(f.read("operations", { operation: "echo" }).operations[0].revision, echo.revision);
});

test("batch validation and coverage version conflicts do not partially save", async t => {
  const f = await fixture(t), before = providerData(f.providers.provider("local"));
  const echo = f.read("operations").operations[0], coverage = f.read("coverage");
  for (const request of [
    { add: [definition] },
    { add: [{ ...definition, name: "new" }], replace: [{ expectedRevision: echo.revision, definition: { ...definition, name: "absent" } }] },
    { add: [{ ...definition, name: "new" }], replace: [{ expectedRevision: echo.revision, definition: { ...definition, name: "new" } }] },
    { add: [] },
    { add: [{ name: "broken", description: "", inputSchema: { type: "object", properties: { x: { type: "string" } }, additionalProperties: false }, argv: [] }] },
  ]) await assert.rejects(f.run({ action: "update", provider: "local", target: "operations", ...request }));
  assert.deepEqual(providerData(f.providers.provider("local")), before);
  const conflict = await f.run({ action: "update", provider: "local", target: "operations", add: [{ ...definition, name: "new" }],
    coverage: { expectedRevision: "stale", value: coverage.coverage } });
  assert.equal(conflict.error.category, "conflict");
  assert.deepEqual(providerData(f.providers.provider("local")), before);
  const saved = await f.run({ action: "update", provider: "local", target: "operations", add: [{ ...definition, name: "new" }],
    coverage: { expectedRevision: coverage.revision, value: { basis: "cat(1)", limitations: ["Known subset"] } } });
  assert.equal(saved.configSaved, true);
  assert.equal(f.read("operations").operations.length, 2);
  assert.deepEqual(f.read("coverage").coverage.limitations, ["Known subset"]);
});

test("outcomes are independent, clear on binding changes and remain on descriptions", async t => {
  const f = await fixture(t);
  const outcomes = { accepted: { type: "object" }, rejected: { const: false } };
  await f.run({ action: "update", provider: "local", target: "outcomes", operation: "echo", expectedRevision: f.read("outcomes", { operation: "echo" }).revision, outcomes });
  let echo = f.read("operations").operations[0];
  assert.equal(echo.definition.outcomes, undefined);
  await f.run({ action: "update", provider: "local", target: "operations", replace: [{ expectedRevision: echo.revision,
    definition: { ...echo.definition, description: "New description" } }] });
  assert.deepEqual(f.providers.operation("local", "echo").outcomes, outcomes);
  echo = f.read("operations").operations[0];
  const confirmation = localConfirmation();
  const pending = f.providers.manage({ action: "update", provider: "local", target: "operations", replace: [{ expectedRevision: echo.revision,
    definition: { ...echo.definition, argv: ["-n"] } }] }, confirmation.ask);
  const { dialog, value } = await confirmation.ready;
  assert.deepEqual(value.clearedOutcomes, ["echo"]);
  assert.deepEqual(f.providers.operation("local", "echo").outcomes, outcomes);
  dialog.handleInput("\r"); await pending;
  assert.equal(f.providers.operation("local", "echo").outcomes, undefined);
  await f.run({ action: "update", provider: "local", target: "outcomes", operation: "echo", expectedRevision: f.read("outcomes", { operation: "echo" }).revision, outcomes: null });
  assert.deepEqual(f.store.list("receipt"), []);
});

test("native definition changes clear outcomes without losing disappeared capabilities", () => {
  const initial = parseProvider({ id: "mcp", kind: "mcp", command: "/usr/bin/false", operations: [] });
  const native = { name: "read", description: "Original", inputSchema: { type: "object" } };
  const known = mergeCatalog(initial, [native]);
  known.operations[0].outcomes = { accepted: { type: "object" }, rejected: { const: false } };
  assert.ok(mergeCatalog(known, [native]).operations[0].outcomes);
  assert.equal(mergeCatalog(known, [{ ...native, inputSchema: { type: "object", required: ["n"] } }]).operations[0].outcomes, undefined);
  const missing = mergeCatalog(known, []);
  assert.equal(missing.operations[0].available, false);
  const returned = mergeCatalog(missing, [native]);
  assert.equal(returned.operations[0].available, true);
  assert.deepEqual(returned.operations[0].outcomes, known.operations[0].outcomes);
});

test("permission suggestions preserve rules; explicit changes and reset use native operation names", async t => {
  const f = await fixture(t);
  await f.run({ action: "update", provider: "local", target: "operations", add: [{ ...definition, name: "orders/cancel" }] });
  const update = (mode, permissions) => f.run({ action: "update", provider: "local", target: "permissions", mode, permissions, expectedRevision: f.read("permissions").revision });
  const first = await update("suggest", { echo: "allow", "orders/cancel": "review" });
  assert.deepEqual(first.permissions.applied, { echo: "allow", "orders/cancel": "review" });
  assert.equal(f.providers.permissions.read().tools["local/orders%2Fcancel"], "review");
  const second = await update("suggest", { echo: "deny" });
  assert.deepEqual(second.permissions.preserved, { echo: "allow" });
  assert.deepEqual(second.permissions.applied, {});
  await update("set", { echo: "deny" });
  assert.equal(f.read("permissions").effective.echo, "deny");
  await update("set", { echo: null });
  assert.equal(f.read("permissions").explicit.echo, undefined);
  assert.equal(f.read("permissions").effective.echo, "ask");
  const path = join(f.root, ".ffa/permissions.json"), config = f.providers.permissions.read();
  await writeFile(path, JSON.stringify({ ...config, default: "deny" }));
  assert.equal(f.read("permissions").effective.echo, "deny");
  assert.equal(f.read("permissions").effective["orders/cancel"], "review");
  await assert.rejects(update("suggest", { "local/echo": "allow" }));
});

for (const change of ["decline", "permissions", "directory", "abort"]) {
  test("management confirmation handles " + change + " without saving proposed rules", async t => {
    const f = await fixture(t), before = f.read("permissions"), controller = new AbortController();
    const confirmation = localConfirmation(controller.signal);
    const pending = f.providers.manage({ action: "update", provider: "local", target: "permissions", expectedRevision: before.revision,
      mode: "set", permissions: { echo: "allow" } }, confirmation.ask, controller.signal);
    const rejection = change === "abort" ? assert.rejects(pending) : undefined;
    const { dialog } = await confirmation.ready;
    if (change === "permissions") await writeFile(join(f.root, ".ffa/permissions.json"), JSON.stringify({ default: "deny", tools: {} }));
    if (change === "directory") {
      const provider = providerData(f.providers.provider("local")); provider.operations[0].description = "Changed";
      f.store.put("provider", "local", provider);
    }
    if (change === "abort") controller.abort();
    else { if (change === "decline") dialog.handleInput("\t"); dialog.handleInput("\r"); }
    if (rejection) await rejection;
    else assert.equal((await pending).error.category, change === "decline" ? "declined" : "conflict");
    assert.equal(f.providers.permissions.read().tools["local/echo"], undefined);
  });
}

test("connection replacement retains directory, removes omitted env and rejects stale updates", async t => {
  const f = await fixture(t);
  const before = f.read("connection"), operations = f.read("operations").operations;
  const config = { ...before.config, env: { LANG: "${LANG}" } };
  assert.equal((await f.run({ action: "update", provider: "local", target: "connection", config, expectedRevision: before.revision })).configSaved, true);
  assert.equal((await f.run({ action: "update", provider: "local", target: "connection", config: before.config, expectedRevision: before.revision })).error.category, "conflict");
  await f.run({ action: "update", provider: "local", target: "connection", config: before.config, expectedRevision: f.read("connection").revision });
  assert.equal(f.providers.provider("local").env, undefined);
  assert.deepEqual(f.read("operations").operations.map(op => op.definition), operations.map(op => op.definition));
  assert.notEqual(f.read("operations").operations[0].revision, operations[0].revision);
});

test("permissions saved before a real SQLite failure are reported and not rolled back", async t => {
  const f = await fixture(t, false), db = new DatabaseSync(join(f.root, ".ffa/business.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_provider BEFORE INSERT ON records WHEN NEW.kind='provider' BEGIN SELECT RAISE(ABORT, 'disk rejected'); END");
  const result = await f.run({ ...registration, permissions: { echo: "allow" } });
  assert.equal(result.configSaved, false);
  assert.equal(result.permissions.status, "complete");
  assert.deepEqual(result.permissions.applied, { echo: "allow" });
  assert.equal(result.error.category, "storage");
  assert.equal(f.providers.permissions.read().tools["local/echo"], "allow");
  assert.equal(f.store.get("provider", "local"), undefined);
});

test("permission file write failure reports unknown without reporting proposed rules as applied", async t => {
  if (process.getuid?.() === 0) { t.skip("Requires OS enforcement of directory write permissions"); return; }
  const f = await fixture(t), path = join(f.root, ".ffa");
  const confirmation = localConfirmation();
  const pending = f.providers.manage({ action: "update", provider: "local", target: "permissions", expectedRevision: f.read("permissions").revision,
    mode: "set", permissions: { echo: "allow" } }, confirmation.ask);
  const { dialog } = await confirmation.ready;
  // Reads and confirmation checks still work; the real atomic file write cannot create its temporary file.
  await chmod(path, 0o500);
  try {
    dialog.handleInput("\r");
    const result = await pending;
    assert.equal(result.error.category, "storage");
    assert.equal(result.permissions.status, "unknown");
    assert.deepEqual(result.permissions.applied, {});
    assert.ok(validOutput(result));
  } finally { await chmod(path, 0o700); }
  assert.equal(f.providers.permissions.read().tools["local/echo"], undefined);
});

test("offline MCP registers once and separates discovery failure from configuration failure", async t => {
  const f = await fixture(t, false);
  const request = { action: "register", provider: "local", config: { kind: "mcp", command: "/usr/bin/false" } };
  const result = await f.run(request);
  assert.equal(result.configSaved, true); assert.equal(result.discovery.status, "failed");
  assert.equal(result.error.category, "discovery");
  assert.equal(result.saved.config.operations, undefined);
  await assert.rejects(f.run(request));
  const refresh = await f.run({ action: "discover", provider: "local" });
  assert.equal(refresh.discovery.status, "failed");
  const again = await f.run({ action: "update", target: "connection", provider: "local", config: request.config, expectedRevision: f.read("connection").revision });
  assert.equal(again.configSaved, true); assert.equal(again.discovery.status, "failed");
  assert.deepEqual(f.store.list("intent"), []);
  assert.deepEqual(f.store.list("receipt"), []);
});

test("discovery persistence failure preserves registration and is not a remote failure", async t => {
  const f = await fixture(t, false), db = new DatabaseSync(join(f.root, ".ffa/business.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_discovery BEFORE INSERT ON records WHEN NEW.kind='provider' AND json_extract(NEW.value,'$.discovery.status')='failed' BEGIN SELECT RAISE(ABORT, 'disk rejected'); END");
  const result = await f.run({ action: "register", provider: "local", config: { kind: "mcp", command: "/usr/bin/false" } });
  assert.equal(result.configSaved, true);
  assert.equal(result.error.category, "storage");
  assert.equal(result.discovery, undefined);
  assert.equal(f.providers.provider("local").discovery.status, "stale");
  assert.equal(f.store.healthy, false);
});

test("permission revisions also bind the operation contract read by the proposer", async t => {
  const f = await fixture(t), permissions = f.read("permissions"), echo = f.read("operations").operations[0];
  await f.run({ action: "update", provider: "local", target: "operations", replace: [
    { expectedRevision: echo.revision, definition: { ...echo.definition, inputSchema: { type: "object", required: ["n"] } } },
  ] });
  const result = await f.run({ action: "update", provider: "local", target: "permissions", mode: "suggest",
    expectedRevision: permissions.revision, permissions: { echo: "allow" } });
  assert.equal(result.error.category, "conflict");
  assert.equal(f.providers.permissions.read().tools["local/echo"], undefined);
});

test("declining combined registration reports every unstarted phase without adding rules", async t => {
  const f = await fixture(t, false), confirmation = localConfirmation();
  const pending = f.providers.manage({ ...registration, permissions: { echo: "allow" } }, confirmation.ask);
  const { dialog } = await confirmation.ready;
  dialog.handleInput("\t"); dialog.handleInput("\r");
  const result = await pending;
  assert.equal(result.configSaved, false);
  assert.equal(result.permissions.status, "not_started");
  assert.equal(result.error.category, "declined");
  assert.equal(f.store.get("provider", "local"), undefined);
  assert.deepEqual(f.providers.permissions.read().tools, {});
});

test("closing management cancels a pending confirmation before storage can close", { timeout: 5000 }, async t => {
  const f = await fixture(t), confirmation = localConfirmation();
  const pending = f.providers.manage({ action: "update", target: "coverage", provider: "local", expectedRevision: f.read("coverage").revision,
    coverage: { basis: "Changed", limitations: [] } }, confirmation.ask);
  const rejected = assert.rejects(pending);
  await confirmation.ready;
  await f.providers.close();
  await rejected;
  assert.equal(f.store.get("provider", "local").coverage.basis, "cat(1)");
});

test("closed instances reject both management reads and edits", async t => {
  const f = await fixture(t), read = f.read("coverage");
  await f.providers.close();
  assert.throws(() => f.read("coverage"));
  await assert.rejects(f.run({ action: "update", target: "coverage", provider: "local", coverage: read.coverage, expectedRevision: read.revision }));
});

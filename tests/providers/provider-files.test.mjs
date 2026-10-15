import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../dist/storage/store.js";
import { ProviderRegistry } from "../../dist/services/providers/provider-registry.js";
import { ProviderConnections } from "../../dist/integrations/providers/provider-connections.js";
import { ExecutionService } from "../../dist/services/execution/execution-service.js";
import { localConfirmation } from "../helpers/local-confirmation.mjs";

const provider = { id: "local", kind: "cli", command: "printf", coverage: { basis: "printf(1)", limitations: [] },
  operations: [{ name: "echo", description: "Print JSON", inputSchema: { type: "object" }, argv: ["%s", { json: true }],
    outcomes: { accepted: { type: "object" }, rejected: { const: false } } }] };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-provider-files-")); await mkdir(join(root, ".ffa"));
  const store = new Store(join(root, ".ffa")); store.providers.save(provider.id, provider);
  const providers = new ProviderRegistry(store, new ProviderConnections(root), root);
  await providers.permissions.initialize();
  const execution = new ExecutionService(providers, store);
  t.after(async () => { await execution.close(); await providers.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const path = name => join(root, ".ffa/providers/local", name);
  return { root, store, providers, execution, path };
}

test("CLI config, definitions and bound outcomes have separate files and load the same provider", async t => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse(await readFile(f.path("config.json"), "utf8")), { kind: "cli", command: "printf" });
  const operations = JSON.parse(await readFile(f.path("operations.json"), "utf8"));
  assert.equal(Object.hasOwn(operations.operations[0], "outcomes"), false);
  assert.deepEqual(JSON.parse(await readFile(f.path("outcomes.json"), "utf8")).echo.outcomes, provider.operations[0].outcomes);
  assert.deepEqual(f.store.providers.get("local"), provider);
});

for (const change of ["connection", "parameters", "outcomes"]) {
  test("external " + change + " editing while approval waits stops sending and requires reload", async t => {
    const f = await fixture(t), confirmation = localConfirmation();
    const pending = f.execution.call({ session: "local" }, "local", "echo", {}, confirmation.ask);
    const stopped = assert.rejects(pending), { dialog } = await confirmation.ready;
    if (change === "connection") await writeFile(f.path("config.json"), JSON.stringify({ kind: "cli", command: "true" }));
    if (change === "parameters") {
      const operations = JSON.parse(await readFile(f.path("operations.json"), "utf8")); operations.operations[0].argv = ["%s", "changed"];
      await writeFile(f.path("operations.json"), JSON.stringify(operations));
    }
    if (change === "outcomes") await writeFile(f.path("outcomes.json"), "{}");
    dialog.handleInput("\r"); await stopped;
    assert.ok(f.store.calls.list().every(record => !record.intent.attempt));
    assert.throws(() => f.providers.provider("local"));
  });
}

test("JSON formatting and key order do not invalidate approval", async t => {
  const f = await fixture(t), confirmation = localConfirmation();
  const pending = f.execution.call({ session: "local" }, "local", "echo", { number: 42 }, confirmation.ask);
  const { dialog } = await confirmation.ready;
  await writeFile(f.path("config.json"), '{"command":"printf", "kind":"cli"}');
  dialog.handleInput("\r");
  assert.equal((await pending).outcome, "accepted");
});

test("description changes retain outcomes while changed input or binding snapshots reject reload", async t => {
  const f = await fixture(t), operations = JSON.parse(await readFile(f.path("operations.json"), "utf8"));
  await f.execution.close(); await f.providers.close(); f.store.close();
  operations.operations[0].description = "Updated explanation";
  await writeFile(f.path("operations.json"), JSON.stringify(operations));
  const reopened = new Store(join(f.root, ".ffa"), false);
  assert.deepEqual(reopened.providers.get("local").operations[0].outcomes, provider.operations[0].outcomes); reopened.close();
  operations.operations[0].inputSchema = { type: "object", required: ["n"] };
  await writeFile(f.path("operations.json"), JSON.stringify(operations));
  assert.throws(() => new Store(join(f.root, ".ffa"), false));
  // Explicit user removal, not an automatic loader repair.
  await writeFile(f.path("outcomes.json"), "{}");
  const edited = new Store(join(f.root, ".ffa"), false);
  assert.equal(edited.providers.get("local").operations[0].outcomes, undefined); edited.close();
});

test("MCP native facts survive unsupported local schema features but inconsistent native bindings are rejected", async t => {
  const f = await fixture(t);
  const native = { name: "unresolved", description: "Native definition", inputSchema: { type: "object", $ref: "unavailable-schema" }, extraNativeFact: { retained: true } };
  f.store.providers.save("catalog", { id: "catalog", kind: "mcp", command: "/usr/bin/false",
    discovery: { status: "complete", at: new Date().toISOString(), scope: "Recorded native facts" },
    operations: [{ name: native.name, description: native.description, inputSchema: native.inputSchema, native, available: true }] });
  assert.deepEqual(f.providers.provider("catalog").operations[0].native, native);
  assert.throws(() => f.providers.preview("catalog", "unresolved", {}));
  assert.deepEqual(f.store.calls.list(), []);
  await f.execution.close(); await f.providers.close(); f.store.close();
  const path = join(f.root, ".ffa/providers/catalog/catalog.json"), catalog = JSON.parse(await readFile(path, "utf8"));
  catalog.operations[0].inputSchema = { type: "object" };
  await writeFile(path, JSON.stringify(catalog));
  assert.throws(() => new Store(join(f.root, ".ffa"), false));
});

test("an incomplete multi-file provider save cannot be treated as an old valid configuration", async t => {
  const f = await fixture(t);
  await f.execution.close(); await f.providers.close(); f.store.close();
  await rm(f.path("outcomes.json"));
  assert.throws(() => new Store(join(f.root, ".ffa"), false));
});

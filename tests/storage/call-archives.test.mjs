import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, chmod, readFile, readdir, writeFile, cp, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Store } from "../../dist/storage/store.js";
import { Ledger } from "../../dist/services/execution/execution-ledger.js";
import { ExecutionService } from "../../dist/services/execution/execution-service.js";
import { ProviderRegistry } from "../../dist/services/providers/provider-registry.js";
import { ProviderConnections } from "../../dist/integrations/providers/provider-connections.js";
import { RecordService } from "../../dist/services/execution/record-service.js";
import { archiveCallLimit } from "../../dist/storage/call-archives.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-archive-")), directory = join(root, ".ffa");
  await mkdir(directory);
  const store = new Store(directory), ledger = new Ledger(store.calls);
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  function create(permission = "allow", state = "observed", data = { prices: [1, 2.5, null], text: "历史行情" }) {
    const intent = ledger.create({ session: "earlier-session" }, "local", "read", { unicode: "行情" }, "binding", permission);
    if (state === "declined") ledger.decline(intent.id);
    else if (state !== "pending") {
      ledger.start(intent.id);
      if (state === "unknown-without-result") ledger.unknown(intent.id);
      else ledger.observe(intent.id, { success: state === "observed", data, raw: { exitCode: 0 } },
        state === "observed" ? "accepted" : "unknown", { id: randomUUID(), at: new Date().toISOString(), success: state === "observed" });
    }
    return store.calls.get(intent.id);
  }
  return { root, directory, store, ledger, create };
}

test("exit archival selects historical allow permissions, preserves ask/review and keeps unknown calls queryable", async t => {
  const f = await fixture(t);
  const records = [f.create("ask"), f.create("review"), f.create(), f.create("allow", "unknown"),
    f.create("allow", "unknown-without-result"), f.create("allow", "declined")];
  const preserved = new Map();
  for (const record of records) preserved.set(record.intent.id, await readFile(join(f.directory, "calls", record.intent.id + ".json")));
  const originalResult = await readFile(join(f.directory, "results", records[2].intent.id + ".json"), "utf8");
  await writeFile(join(f.directory, "results/orphan.json"), '{"data":"unassociated evidence"}\n');
  // Present-day permissions must not reclassify historical approvals.
  await writeFile(join(f.directory, "permissions.json"), JSON.stringify({ default: "review", tools: {} }));
  const providers = new ProviderRegistry(f.store, new ProviderConnections(f.root), f.root);
  const service = new ExecutionService(providers, f.store);
  assert.throws(() => service.archiveHistory());
  await service.close(); await providers.close(); service.archiveHistory(); service.archiveHistory();
  assert.deepEqual((await readdir(join(f.directory, "calls"))).sort(), records.slice(0, 2).map(record => record.intent.id + ".json").sort());
  assert.deepEqual((await readdir(join(f.directory, "results"))).sort(),
    [...records.slice(0, 2).map(record => record.intent.id + ".json"), "orphan.json"].sort());
  for (const record of records.slice(0, 2)) assert.deepEqual(await readFile(join(f.directory, "calls", record.intent.id + ".json")), preserved.get(record.intent.id));
  const [batch] = await readdir(join(f.directory, "archives"));
  assert.ok(batch);
  const archive = join(f.directory, "archives", batch);
  const index = JSON.parse(await readFile(join(archive, "records.json"), "utf8"));
  assert.deepEqual(new Map(index.calls.map(record => [record.intent.id, record])),
    new Map(records.slice(2).map(record => [record.intent.id, record])));
  const results = JSON.parse(gunzipSync(await readFile(join(archive, "results.json.gz"))).toString());
  assert.equal(results[records[2].intent.id], originalResult);
  assert.equal((await stat(archive)).mode & 0o777, 0o700);
  assert.equal((await stat(join(archive, "results.json.gz"))).mode & 0o777, 0o600);
  f.store.close();
  const reopened = new Store(f.directory, false);
  try {
    const ledger = new Ledger(reopened.calls); ledger.recover();
    assert.deepEqual(ledger.unknownCalls().map(intent => intent.id).sort(), records.slice(3, 5).map(record => record.intent.id).sort());
    for (const record of records) assert.deepEqual(reopened.calls.get(record.intent.id), record);
    const changed = reopened.calls.get(records[2].intent.id); changed.intent.parameters.unicode = "changed";
    assert.deepEqual(reopened.calls.get(records[2].intent.id), records[2]);
    assert.throws(() => ledger.start(records[2].intent.id));
    const receipt = new RecordService(reopened.calls).read("receipt", records[2].receipt.id);
    assert.deepEqual(JSON.parse(await readFile(receipt.dataPath, "utf8")), JSON.parse(originalResult));
    reopened.calls.archive(records.slice(2).map(record => record.intent.id));
    await assert.rejects(readFile(receipt.dataPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(f.directory, "archives")), [batch]);
  } finally { reopened.close(); }
});

test("ffa/0.3 workspaces open unchanged without an archive directory and archive existing records on exit", async t => {
  const f = await fixture(t), record = f.create();
  const statePath = join(f.directory, "workspace.json"), state = '{ "format": "ffa/0.3", "status": "ready" }\n';
  await writeFile(statePath, state);
  const names = await readdir(f.directory);
  const callPath = join(f.directory, "calls", record.intent.id + ".json"), before = await readFile(callPath);
  f.store.close();
  const reopened = new Store(f.directory, false);
  try {
    assert.deepEqual(await readdir(f.directory), names);
    assert.equal(await readFile(statePath, "utf8"), state);
    assert.deepEqual(await readFile(callPath), before);
    assert.deepEqual(reopened.calls.get(record.intent.id), record);
    const providers = new ProviderRegistry(reopened, new ProviderConnections(f.root), f.root);
    const service = new ExecutionService(providers, reopened);
    await service.close(); await providers.close(); service.archiveHistory();
    assert.equal((await readdir(join(f.directory, "archives"))).length, 1);
    assert.equal(await readFile(statePath, "utf8"), state);
    assert.deepEqual(reopened.calls.get(record.intent.id), record);
    await assert.rejects(readFile(callPath), { code: "ENOENT" });
  } finally { reopened.close(); }
});

test("archive batches are bounded and an empty exit creates no files", async t => {
  const f = await fixture(t);
  f.store.calls.archive([]);
  await assert.rejects(readdir(join(f.directory, "archives")), { code: "ENOENT" });
  const records = Array.from({ length: archiveCallLimit + 1 }, () => f.create("allow", "declined"));
  f.store.calls.archive(records.map(record => record.intent.id));
  const batches = await readdir(join(f.directory, "archives"));
  assert.equal(batches.length, 2);
  assert.deepEqual(await readdir(join(f.directory, "calls")), []);
  assert.equal(f.store.calls.list().length, records.length);
  for (const name of batches) {
    const index = JSON.parse(await readFile(join(f.directory, "archives", name, "records.json"), "utf8"));
    assert.ok(index.calls.length <= archiveCallLimit);
  }
});

test("large result bodies split archives before the record-count limit", async t => {
  const f = await fixture(t);
  const records = [f.create("allow", "observed", "x".repeat(8 * 1024 * 1024)),
    f.create("allow", "observed", "y".repeat(8 * 1024 * 1024))];
  f.store.calls.archive(records.map(record => record.intent.id));
  assert.equal((await readdir(join(f.directory, "archives"))).length, 2);
  const path = f.store.calls.receipt(records[1].receipt.id).dataPath;
  assert.equal(JSON.parse(await readFile(path, "utf8")).data, "y".repeat(8 * 1024 * 1024));
});

test("invalid UTF-8 result bytes are not silently replaced during compression", async t => {
  const f = await fixture(t), record = f.create();
  const path = join(f.directory, "results", record.intent.id + ".json");
  const broken = Buffer.concat([Buffer.from('{"data":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await writeFile(path, broken);
  assert.throws(() => f.store.calls.archive([record.intent.id]));
  assert.deepEqual(await readFile(path), broken);
  assert.deepEqual(f.store.calls.get(record.intent.id), record);
  await assert.rejects(readdir(join(f.directory, "archives")), { code: "ENOENT" });
});

for (const denied of ["archives", "calls", "results"]) {
  test("archive failure in " + denied + " preserves evidence and a later exit resumes without duplicate archives", async t => {
    if (process.getuid?.() === 0) return t.skip("Requires OS permission enforcement");
    const f = await fixture(t), record = f.create(), id = record.intent.id;
    const path = join(f.directory, denied);
    if (denied === "archives") await mkdir(path);
    await chmod(path, 0o500);
    try { assert.throws(() => f.store.calls.archive([id])); }
    finally { await chmod(path, 0o700); }
    assert.equal(f.store.healthy, false);
    const batches = await readdir(join(f.directory, "archives"));
    assert.equal(batches.length, denied === "archives" ? 0 : 1);
    assert.deepEqual(f.store.calls.get(id), record);
    assert.ok(JSON.parse(await readFile(join(f.directory, "results", id + ".json"), "utf8")).data);
    f.store.close();
    const next = new Store(f.directory, false);
    try {
      assert.equal(next.calls.list().length, 1);
      assert.deepEqual(next.calls.get(id), record);
      next.calls.archive([id]);
      assert.deepEqual(await readdir(join(f.directory, "calls")), []);
      assert.deepEqual(await readdir(join(f.directory, "results")), []);
      assert.equal((await readdir(join(f.directory, "archives"))).length, 1);
      assert.ok(next.calls.receipt(record.receipt.id).dataPath);
    } finally { next.close(); }
  });
}

for (const corruption of ["compressed data", "index"]) test("corrupt archive " + corruption + " cannot cause removal of remaining source files", async t => {
  if (process.getuid?.() === 0) return t.skip("Requires OS permission enforcement");
  const f = await fixture(t), record = f.create(), id = record.intent.id;
  await chmod(join(f.directory, "calls"), 0o500);
  try { assert.throws(() => f.store.calls.archive([id])); }
  finally { await chmod(join(f.directory, "calls"), 0o700); }
  f.store.close();
  const [name] = await readdir(join(f.directory, "archives"));
  const next = new Store(f.directory, false);
  try {
    if (corruption === "compressed data") await writeFile(join(f.directory, "archives", name, "results.json.gz"), "broken gzip");
    else {
      const path = join(f.directory, "archives", name, "records.json");
      const index = JSON.parse(await readFile(path, "utf8")); index.calls[0].intent.parameters = { changed: true };
      await writeFile(path, JSON.stringify(index));
    }
    assert.throws(() => next.calls.archive([id]));
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, "calls", id + ".json"), "utf8")), record);
    assert.ok(JSON.parse(await readFile(join(f.directory, "results", id + ".json"), "utf8")).data);
  } finally { next.close(); }
});

test("archived receipts restore under a copied workspace without changing the archive", async t => {
  const f = await fixture(t), record = f.create();
  f.store.calls.archive([record.intent.id]); f.store.close();
  const copy = join(f.root, "copy"); await cp(f.directory, copy, { recursive: true });
  const next = new Store(copy, false);
  try {
    const receipt = next.calls.receipt(record.receipt.id);
    assert.equal(receipt.dataPath, join(copy, "results", record.intent.id + ".json"));
    assert.deepEqual(JSON.parse(await readFile(receipt.dataPath, "utf8")).data.prices, [1, 2.5, null]);
    await assert.rejects(readFile(join(f.directory, "results", record.intent.id + ".json")), { code: "ENOENT" });
  } finally { next.close(); }
});

test("archives reject aliases, inconsistent duplicates and missing referenced results", async t => {
  const f = await fixture(t), record = f.create();
  f.store.calls.archive([record.intent.id]); f.store.close();
  await symlink(f.root, join(f.directory, "archives/alias"));
  assert.throws(() => new Store(f.directory, false));
  await rm(join(f.directory, "archives/alias"));
  const changed = structuredClone(record); changed.intent.parameters = { changed: true };
  await writeFile(join(f.directory, "calls", record.intent.id + ".json"), JSON.stringify(changed));
  assert.throws(() => new Store(f.directory, false));
  await rm(join(f.directory, "calls", record.intent.id + ".json"));
  const [name] = await readdir(join(f.directory, "archives"));
  await rm(join(f.directory, "archives", name, "results.json.gz"));
  assert.throws(() => new Store(f.directory, false));
});

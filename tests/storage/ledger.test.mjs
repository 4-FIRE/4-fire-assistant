import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../dist/storage/store.js";
import { Ledger } from "../../dist/services/execution/execution-ledger.js";
import { classify } from "../../dist/services/execution/execution-service.js";

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "ffa-ledger-"));
  const store = new Store(path); t.after(() => { store.close(); return rm(path, { recursive: true, force: true }); });
  return { path, store, ledger: new Ledger(store.calls) };
}
const scope = { session: "pi-session" };
function create(ledger, args = { quantity: 1 }) { return ledger.create(scope, "broker", "submit", args, "binding", "review"); }
test("one record sends once; identical and unknown calls do not block new requests", async t => {
  const { ledger } = await fixture(t);
  const first = create(ledger);
  assert.notEqual(create(ledger).id, first.id);
  const second = create(ledger, { quantity: 2 });
  ledger.start(first.id);
  assert.throws(() => ledger.start(first.id));
  assert.equal(ledger.start(second.id).state, "dispatched");
  assert.equal(create(ledger, { quantity: 3 }).state, "pending");
  ledger.unknown(first.id);
  assert.throws(() => ledger.start(first.id));
  assert.equal(ledger.get(first.id).state, "unknown");
  assert.throws(() => ledger.start(second.id));
});
test("declined calls never acquire a sending attempt", async t => {
  const { ledger } = await fixture(t), intent = create(ledger);
  assert.equal(ledger.decline(intent.id).state, "declined");
  assert.throws(() => ledger.start(intent.id));
  assert.equal(ledger.get(intent.id).attempt, undefined);
});
test("reopen changes incomplete attempts to unknown, independent of chat branches", async t => {
  const { path, store, ledger } = await fixture(t);
  const pending = create(ledger), intent = create(ledger); ledger.start(intent.id); store.close();
  const reopened = new Store(path, false);
  try {
    const other = new Ledger(reopened.calls); other.recover();
    assert.equal(other.get(intent.id).state, "unknown");
    assert.equal(other.get(pending.id).state, "declined");
    assert.equal(other.create({ session: "fork" }, "broker", "submit", { quantity: 1 }, "new-binding", "review").state, "pending");
    assert.throws(() => other.start(intent.id));
  } finally { reopened.close(); }
});
test("invalid file data is rejected and a second owner cannot access the ledger", async t => {
  const { path, store } = await fixture(t);
  assert.throws(() => new Store(path));
  assert.throws(() => store.settings.save({ unknown: true }));
  assert.deepEqual(store.settings.read(), {});
  store.settings.save({ python: "/usr/bin/python3" });
  assert.deepEqual(store.settings.read(), { python: "/usr/bin/python3" });
});
test("ready workspaces must not silently replace a missing ledger", async t => {
  const path = await mkdtemp(join(tmpdir(), "ffa-missing-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  assert.throws(() => new Store(path, false));
  const store = new Store(path); store.close();
  assert.deepEqual((await readdir(path)).sort(), ["calls", "owner.lock", "providers", "results", "settings.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(path, "settings.json"), "utf8")), {});
  await rm(join(path, "settings.json"));
  assert.throws(() => new Store(path, false));
  assert.throws(() => new Store(path));
});
test("unrecognized storage is never adopted or overwritten by initialization", async t => {
  const path = await mkdtemp(join(tmpdir(), "ffa-unsupported-store-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const file = join(path, "records.bin"), value = Buffer.from([0, 255, 17, 42]);
  await writeFile(file, value);
  assert.throws(() => new Store(path, false));
  assert.throws(() => new Store(path));
  assert.deepEqual(await readFile(file), value);
  assert.deepEqual((await readdir(path)).sort(), ["owner.lock", "records.bin"]);
});

test("only one complete non-conflicting receipt classification is known", () => {
  const op = { outcomes: { accepted: { type: "object", required: ["accepted"], properties: { accepted: { const: true } } },
    rejected: { type: "object", required: ["rejected"], properties: { rejected: { const: true } } } } };
  assert.equal(classify({ success: true, data: { accepted: true } }, op), "accepted");
  assert.equal(classify({ success: true, data: { rejected: true } }, op), "rejected");
  for (const data of [{}, { accepted: true, rejected: true }, null]) assert.equal(classify({ success: true, data }, op), "unknown");
  assert.equal(classify({ success: false, data: { accepted: true } }, op), "unknown");
});
test("observations cannot overwrite receipts or authorize resends", async t => {
  const { ledger } = await fixture(t), intent = create(ledger);
  const receipt = { id: "receipt", provider: intent.provider, operation: intent.operation, parameters: intent.parameters,
    binding: intent.binding, at: intent.createdAt, success: true, data: { status: "received" } };
  ledger.start(intent.id);
  ledger.observe(intent.id, { success: true, data: receipt.data }, "accepted", receipt);
  assert.equal(ledger.get(intent.id).state, "observed");
  assert.throws(() => ledger.observe(intent.id, { success: false, data: null }, "unknown", receipt));
  assert.throws(() => ledger.start(intent.id));
  assert.throws(() => ledger.unknown(intent.id));
});

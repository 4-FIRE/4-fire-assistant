import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { Ledger } from "../dist/services/execution-ledger.js";
import { classify } from "../dist/services/provider-registry.js";

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "ffa-ledger-"));
  const store = new Store(path); t.after(() => { store.close(); return rm(path, { recursive: true, force: true }); });
  return { path, store, ledger: new Ledger(store) };
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
  assert.throws(() => ledger.resolve(first.id, "Not yet unknown"));
  ledger.unknown(first.id);
  assert.throws(() => ledger.resolve(first.id, " "));
  ledger.resolve(first.id, "Checked external order identity and disposition");
  assert.throws(() => ledger.start(first.id));
  assert.equal(ledger.get(first.id).state, "closed");
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
    const other = new Ledger(reopened); other.recover();
    assert.equal(other.get(intent.id).state, "unknown");
    assert.equal(other.get(pending.id).state, "declined");
    assert.equal(other.create({ session: "fork" }, "broker", "submit", { quantity: 1 }, "new-binding", "review").state, "pending");
    assert.throws(() => other.start(intent.id));
  } finally { reopened.close(); }
});
test("failed transaction rolls back and a second owner cannot access the ledger", async t => {
  const { path, store } = await fixture(t);
  assert.throws(() => new Store(path));
  assert.throws(() => store.transaction(() => { store.put("record", "id", { changed: true }); throw new Error("rollback"); }));
  assert.equal(store.get("record", "id"), undefined);
  store.put("record", "id", { changed: false });
  assert.deepEqual(store.get("record", "id"), { changed: false });
});
test("ready workspaces must not silently replace a missing ledger", async t => {
  const path = await mkdtemp(join(tmpdir(), "ffa-missing-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  assert.throws(() => new Store(path, false));
  const store = new Store(path); store.close();
  const db = new DatabaseSync(join(path, "business.sqlite"));
  try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1); }
  finally { db.close(); }
});
test("unsupported ledger versions are rejected without migrating or deleting records", async t => {
  const path = await mkdtemp(join(tmpdir(), "ffa-unsupported-ledger-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const file = join(path, "business.sqlite"), db = new DatabaseSync(file);
  const value = JSON.stringify({ state: "unknown", externalId: "local-reference" });
  db.exec("CREATE TABLE records (kind TEXT, id TEXT, value TEXT); PRAGMA user_version=3");
  db.prepare("INSERT INTO records VALUES (?,?,?)").run("intent", "history", value);
  db.close();
  assert.throws(() => new Store(path, false));
  const preserved = new DatabaseSync(file);
  try {
    assert.equal(preserved.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(preserved.prepare("SELECT value FROM records WHERE id=?").get("history").value, value);
  } finally { preserved.close(); }
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../dist/storage/store.js";
import { callState, parseCallRecord } from "../../dist/storage/call-record.js";
import { Ledger } from "../../dist/services/execution/execution-ledger.js";
import { RecordService } from "../../dist/services/execution/record-service.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-call-record-")), store = new Store(root), ledger = new Ledger(store.calls);
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  const create = () => ledger.create({ session: "original-session" }, "local", "read", {
    unicode: "历史记录", values: [true, null, 1.25], text: "x".repeat(4096),
  }, "original-binding", "review");
  const observe = (id, outcome = "accepted") => {
    const intent = ledger.get(id);
    const data = { result: "original result", nested: [1, false, null] };
    return ledger.observe(id, { success: outcome !== "unknown", data, raw: { status: "original observation" } }, outcome, {
      id: randomUUID(), provider: intent.provider, operation: intent.operation, parameters: intent.parameters,
      binding: intent.binding, at: new Date().toISOString(), success: outcome === "accepted", data,
    });
  };
  return { root, store, ledger, create, observe };
}

test("metadata reads are detached and unknown results remain immutable across recovery", async t => {
  const f = await fixture(t), intent = f.create();
  f.ledger.start(intent.id); f.observe(intent.id, "unknown");
  const before = f.store.calls.get(intent.id), detached = f.store.calls.get(intent.id);
  detached.intent.parameters.unicode = "changed"; detached.events.length = 0; detached.receipt.success = true;
  assert.deepEqual(f.store.calls.get(intent.id), before);
  const receipt = new RecordService(f.store.calls).read("receipt", before.receipt.id);
  assert.deepEqual(JSON.parse(await readFile(receipt.dataPath, "utf8")).data, { result: "original result", nested: [1, false, null] });
  assert.equal(receipt.data, undefined);
  f.ledger.recover(); f.ledger.recover();
  assert.deepEqual(f.store.calls.get(intent.id), before);
  assert.throws(() => f.ledger.start(intent.id));
});

for (const change of ["remove event", "rewrite event", "replace receipt", "replace attempt", "replace observation", "change parameters", "duplicate event id"]) {
  test("saving an aggregate rejects " + change + " and keeps the complete old record", async t => {
    const f = await fixture(t), intent = f.create();
    f.ledger.start(intent.id); f.observe(intent.id, "unknown");
    const before = f.store.calls.get(intent.id), next = structuredClone(before);
    next.events.push({ id: randomUUID(), event: "observed", at: new Date().toISOString(), data: callState(next.intent) });
    switch (change) {
      case "remove event": next.events.splice(0, 1); break;
      case "rewrite event": next.events[0].at = "2000-01-01T00:00:00.000Z"; break;
      case "replace receipt": next.receipt.at = "2001-01-01T00:00:00.000Z"; break;
      case "replace attempt": next.intent.attempt.id = randomUUID(); next.events.at(-1).data = callState(next.intent); break;
      case "replace observation": next.intent.observation.success = !next.intent.observation.success; next.events.at(-1).data = callState(next.intent); break;
      case "change parameters":
        next.intent.parameters = {}; next.events.at(-1).data = callState(next.intent); break;
      case "duplicate event id": next.events.at(-1).id = next.events[0].id; break;
    }
    assert.throws(() => f.store.calls.save(next));
    assert.deepEqual(f.store.calls.get(intent.id), before);
    assert.equal(f.store.healthy, true);
  });
}

test("a failed aggregate replacement preserves the entire old file and stops subsequent writes", async t => {
  if (process.getuid?.() === 0) return t.skip("Requires OS permission enforcement");
  const f = await fixture(t), intent = f.create();
  f.ledger.start(intent.id);
  const before = f.store.calls.get(intent.id), path = join(f.root, "calls", intent.id + ".json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), before);
  await chmod(join(f.root, "calls"), 0o500);
  try { assert.throws(() => f.observe(intent.id)); }
  finally { await chmod(join(f.root, "calls"), 0o700); }
  assert.deepEqual(f.store.calls.get(intent.id), before);
  assert.equal(f.store.healthy, false);
  assert.throws(() => f.create());
});

test("aggregate schema rejects partial observations, unsafe IDs and inconsistent latest snapshots", async t => {
  const f = await fixture(t), intent = f.create(), before = f.store.calls.get(intent.id);
  for (const change of [
    record => { record.intent.id = "../outside"; },
    record => { record.intent.attempt = { id: randomUUID(), at: new Date().toISOString() }; },
    record => { record.intent.receiptId = randomUUID(); },
    record => { record.intent.state = "declined"; },
    record => { record.intent.state = "closed"; },
    record => { record.intent.resolution = "unsupported field"; },
  ]) {
    const value = structuredClone(before); change(value);
    assert.throws(() => parseCallRecord(value));
  }
  assert.deepEqual(f.store.calls.get(intent.id), before);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { readJsonFile, writeJsonFile } from "../../dist/storage/atomic-json.js";
import { PermissionFile } from "../../dist/storage/permission-file.js";
import { Store } from "../../dist/storage/store.js";
import { Ledger } from "../../dist/services/execution/execution-ledger.js";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function record(value) {
  assert.equal(typeof value, "object");
  assert.equal(typeof value.generation, "number");
  assert.equal(typeof value.payload, "string");
  assert.deepEqual(Object.keys(value).sort(), ["generation", "payload"]);
  return value;
}
const initial = { generation: 0, payload: "original" };

test("atomic JSON validates before replacing and writes private, complete plain data", async t => {
  const root = await directory(t);
  writeJsonFile(root, "record.json", initial, record);
  assert.deepEqual(readJsonFile(root, "record.json", record), initial);
  assert.equal(await readFile(join(root, "record.json"), "utf8"), JSON.stringify(initial, null, 2) + "\n");
  assert.equal((await stat(join(root, "record.json"))).mode & 0o777, 0o600);
  for (const value of [{ generation: "0", payload: "invalid" }, { ...initial, extra: true }]) {
    assert.throws(() => writeJsonFile(root, "record.json", value, record));
  }
  for (const value of [{ value: undefined }, { value: Infinity }, { value: 1n }, new Date(), new Array(1)]) {
    assert.throws(() => writeJsonFile(root, "record.json", value, value => value));
  }
  assert.deepEqual(readJsonFile(root, "record.json", record), initial);
  assert.deepEqual(await readdir(root), ["record.json"]);
  assert.equal(writeJsonFile(root, "record.json", { generation: 1, payload: "new" }, record, true), false);
  assert.deepEqual(readJsonFile(root, "record.json", record), initial);
  assert.equal(writeJsonFile(root, "created.json", initial, record, true), true);
  assert.deepEqual(await readdir(root), ["created.json", "record.json"]);
});

test("internal JSON rejects aliases, traversal, malformed JSON and non-files without repair", async t => {
  const root = await directory(t), outside = await directory(t);
  await writeFile(join(outside, "record.json"), JSON.stringify(initial));
  await symlink(outside, join(root, "alias"));
  await symlink(join(outside, "record.json"), join(root, "linked.json"));
  await symlink(join(outside, "missing.json"), join(root, "dangling.json"));
  await mkdir(join(root, "directory.json"));
  for (const path of ["../record.json", "/record.json", "./record.json", "a//record.json", "a\\record.json",
    "alias/record.json", "linked.json", "dangling.json", "directory.json"]) {
    assert.throws(() => readJsonFile(root, path, record));
    assert.throws(() => writeJsonFile(root, path, initial, record));
  }
  assert.equal(await readFile(join(outside, "record.json"), "utf8"), JSON.stringify(initial));
  assert.deepEqual(await readdir(outside), ["record.json"]);
  await writeFile(join(root, "broken.json"), "{broken");
  assert.throws(() => readJsonFile(root, "broken.json", record));
  assert.equal(await readFile(join(root, "broken.json"), "utf8"), "{broken");
  const fifo = spawnSync("mkfifo", [join(root, "pipe.json")]);
  assert.equal(fifo.status, 0);
  assert.throws(() => readJsonFile(root, "pipe.json", record));
  assert.throws(() => writeJsonFile(root, "pipe.json", initial, record));
});

test("concurrent readers see a complete old or new JSON document", { timeout: 20_000 }, async t => {
  const root = await directory(t);
  writeJsonFile(root, "record.json", { generation: 0, payload: "0".repeat(16_384) }, record);
  const module = new URL("../../dist/storage/atomic-json.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeJsonFile } from ${JSON.stringify(module)};
    for (let generation = 1; generation <= 100; generation++) {
      writeJsonFile(${JSON.stringify(root)}, "record.json", { generation, payload: String(generation).repeat(16384) }, value => value);
    }
  `], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let error = "", done = false;
  child.stderr.setEncoding("utf8").on("data", value => { error += value; });
  const finished = once(child, "exit").then(([code]) => { done = true; assert.equal(code, 0, error); });
  while (!done) {
    const current = readJsonFile(root, "record.json", record);
    assert.equal(current.payload, String(current.generation).repeat(16_384));
    await setImmediate();
  }
  await finished;
  assert.equal(readJsonFile(root, "record.json", record).generation, 100);
  assert.deepEqual(await readdir(root), ["record.json"]);
});

test("separate processes can open the same storage without flock", async t => {
  const root = await directory(t), store = new Store(root);
  t.after(() => store.close());
  const module = new URL("../../dist/storage/store.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { Store } from ${JSON.stringify(module)};
    const store = new Store(${JSON.stringify(root)}, false);
    if (!store.healthy) process.exit(1);
    store.close();
  `], { env: { PATH: "" }, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.healthy, true);
  const other = new Store(root, false);
  store.close(); store.close();
  assert.equal(other.healthy, true);
  other.close();
});

for (const duplicate of ["receipt", "event"]) {
  test("opening file storage rejects a duplicate " + duplicate + " across separate calls", async t => {
    const root = await directory(t), store = new Store(root), ledger = new Ledger(store.calls);
    const records = [];
    for (let index = 0; index < 2; index++) {
      const intent = ledger.create({ session: "local" }, "local", "read", {}, "binding", "ask");
      ledger.start(intent.id);
      ledger.observe(intent.id, { success: true, data: {} }, "accepted", { id: randomUUID(), provider: "local", operation: "read",
        parameters: {}, binding: "binding", at: new Date().toISOString(), success: true, data: {} });
      records.push(store.calls.get(intent.id));
    }
    store.close();
    const [first, second] = records;
    if (duplicate === "event") second.events[0].id = first.events[0].id;
    else {
      second.receipt.id = first.receipt.id;
      second.intent.receiptId = first.receipt.id;
      for (const event of second.events) if (event.data.receiptId) event.data.receiptId = first.receipt.id;
    }
    await writeFile(join(root, "calls", second.intent.id + ".json"), JSON.stringify(second));
    assert.throws(() => new Store(root, false));
  });
}

test("permission initialization never overwrites existing or malformed configuration", async t => {
  const root = await directory(t), file = new PermissionFile(root);
  await file.initialize();
  const path = join(root, ".ffa/permissions.json");
  const config = { default: "deny", tools: { "local/read": "review" } };
  await writeFile(path, JSON.stringify(config));
  await file.initialize();
  assert.deepEqual(file.read(), config);
  await writeFile(path, "{broken");
  await file.initialize();
  assert.throws(() => file.read());
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("permission write failure latches the instance closed even after disk access is restored", async t => {
  if (process.getuid?.() === 0) return t.skip("root bypasses directory write permissions");
  const root = await directory(t), file = new PermissionFile(root);
  await file.initialize();
  const internal = join(root, ".ffa");
  await chmod(internal, 0o500);
  try { await assert.rejects(file.write({ default: "allow", tools: {} })); }
  finally { await chmod(internal, 0o700); }
  assert.throws(() => file.checkHealthy());
  assert.deepEqual(file.read(), { default: "ask", tools: {} });
  await assert.rejects(file.write({ default: "allow", tools: {} }));
  assert.deepEqual(new PermissionFile(root).read(), { default: "ask", tools: {} });
});

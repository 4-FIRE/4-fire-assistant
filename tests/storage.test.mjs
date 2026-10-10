import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { InstanceLock, openApplicationStorage } from "../dist/infrastructure/storage.js";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "4fire-storage-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("WAL + FULL is verified; documents survive reopen; ownership releases on close", async t => {
  const path = await directory(t);
  const Ledger = defineDoc({ kind: "test.ledger", version: 1, scope: "session", initial: () => ({ values: [] }) });
  let handle = await openApplicationStorage(path);
  assert.deepEqual(handle.durability, { journalMode: "wal", synchronous: 2 });
  let harness = await Harness.open(handle.storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.commit(async tx => { (await tx.doc(Ledger)).values.push("durable"); }, BACKGROUND_CONTEXT);
  await assert.rejects(openApplicationStorage(path), { code: "INSTANCE_IN_USE" });
  await harness.close(BACKGROUND_CONTEXT);
  await handle.close();
  await handle.close();
  handle = await openApplicationStorage(path);
  harness = await Harness.open(handle.storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  assert.deepEqual((await harness.snapshot(Ledger, BACKGROUND_CONTEXT)).values, ["durable"]);
  await harness.close(BACKGROUND_CONTEXT);
  await handle.close();
  if (process.platform !== "win32") assert.equal((await stat(join(path, "state.sqlite"))).mode & 0o777, 0o600);
});
test("OS ownership lock rejects another process and automatically releases after SIGKILL", { timeout: 10_000 }, async t => {
  const path = await directory(t);
  const child = fork(new URL("./helpers/lock-owner.mjs", import.meta.url), [path], {
    execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => child.kill("SIGKILL"));
  const [message] = await once(child, "message");
  assert.equal(message.ready, true);
  await assert.rejects(InstanceLock.acquire(path), { code: "INSTANCE_IN_USE" });
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  const lock = await InstanceLock.acquire(path);
  lock.close();
});
test("canonical directory aliases share the same lock", { skip: process.platform === "win32" }, async t => {
  const base = await directory(t);
  const actual = join(base, "actual");
  const first = await openApplicationStorage(actual);
  await symlink(actual, join(base, "alias"), "dir");
  assert.equal(first.directory, await realpath(actual));
  await assert.rejects(openApplicationStorage(join(base, "alias")), { code: "INSTANCE_IN_USE" });
  await first.close();
});

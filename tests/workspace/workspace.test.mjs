import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, mkdir, writeFile, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { begin, state } from "../../dist/storage/workspace-state.js";
import { Store } from "../../dist/storage/store.js";
import { prepareWorkspace, documentsReady, finish, startInitialization } from "../../dist/services/workspace/initialization-service.js";
import { mutationTarget } from "../../dist/common/files.js";
import { approveLocally, localConfirmation } from "../helpers/local-confirmation.mjs";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test("inspection is read-only; explicit initialization persists pending without overwriting documents", async t => {
  const root = await directory(t);
  await writeFile(join(root, "AGENTS.md"), "User-owned instructions");
  assert.equal(await state(root), undefined);
  assert.deepEqual(await readdir(root), ["AGENTS.md"]);
  assert.equal((await begin(root)).status, "pending");
  assert.equal((await state(root)).format, "ffa/0.3");
  await prepareWorkspace(root);
  assert.deepEqual(await begin(root), await state(root));
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "User-owned instructions");
  await documentsReady(root);
  await writeFile(join(root, "AGENTS.md"), "");
  await assert.rejects(documentsReady(root));
  await writeFile(join(root, "AGENTS.md"), "User-owned instructions");
  await documentsReady(root);
  await finish(root, "market");
  assert.equal((await state(root)).status, "ready");
  await assert.rejects(finish(root, "other"));
});
test("market-free state persists without adding a market or overwriting documents", async t => {
  const root = await directory(t);
  await begin(root);
  await prepareWorkspace(root);
  await documentsReady(root);
  for (const market of ["", "   ", "x".repeat(257), null, 1]) await assert.rejects(finish(root, market));
  assert.equal((await state(root)).status, "pending");
  await finish(root);
  const ready = { format: "ffa/0.3", status: "ready" };
  assert.deepEqual({ ...await state(root) }, ready);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".ffa/workspace.json"), "utf8")), ready);
  await assert.rejects(finish(root));
});

for (const market of ["", "   ", "x".repeat(257), null, 1]) {
  test("state rejects invalid explicit market " + JSON.stringify(market), async t => {
    const root = await directory(t);
    await begin(root);
    const path = join(root, ".ffa/workspace.json"), value = JSON.stringify({ format: "ffa/0.3", status: "ready", market });
    await writeFile(path, value);
    await assert.rejects(state(root));
    assert.equal(await readFile(path, "utf8"), value);
  });
}

test("confirmed initialization prepares a root entry before returning and preserves edits on resume", async t => {
  const root = await directory(t);
  const initial = await startInitialization(root, approveLocally);
  assert.equal(initial.status, "pending");
  const entry = join(root, "AGENTS.md");
  assert.ok((await stat(entry)).isFile());
  assert.ok((await stat(entry)).size > 0);
  for (const name of ["areas", "projects", "knowledge", "providers", "scratch", "agents"]) {
    assert.deepEqual(await readdir(join(root, name)), []);
  }
  await writeFile(entry, "User-owned instructions");
  await startInitialization(root, approveLocally);
  assert.equal(await readFile(entry, "utf8"), "User-owned instructions");
});
test("declining initialization creates neither state nor a root entry", async t => {
  const root = await directory(t), confirmation = localConfirmation();
  const pending = startInitialization(root, confirmation.ask);
  const rejected = assert.rejects(pending);
  const { dialog } = await confirmation.ready;
  dialog.handleInput("\x1b");
  await rejected;
  assert.deepEqual(await readdir(root), []);
});
test("old and damaged state is rejected without being replaced", async t => {
  const root = await directory(t);
  await mkdir(join(root, ".ffa"));
  await writeFile(join(root, ".ffa/config.json"), '{"version":3}');
  await assert.rejects(state(root));
  await assert.rejects(begin(root));
  assert.deepEqual(await readdir(join(root, ".ffa")), ["config.json"]);
});
for (const unsupported of [
  { format: "ffa-pi/1", status: "ready" },
  { format: "ffa-pi/1", status: "ready", storage: "files" },
  { format: "ffa-pi/1", status: "ready", storage: "files/2" },
  { format: "ffa-pi/2", status: "ready" },
  { format: "ffa/0.2", status: "ready" },
  { format: "ffa/0.4", status: "ready" },
  { format: "ffa/0.3.0", status: "ready" },
  { format: "ffa/1", status: "ready" },
  { format: "ffa/0.3", status: "ready", storage: "files/2" },
  { format: "ffa/0.3", status: ["ready"] },
  { format: "ffa/0.3", status: ["pending"] },
  { format: "ffa/0.3" },
]) {
  test("unsupported workspace contract is rejected without touching files: " + JSON.stringify(unsupported), async t => {
    const root = await directory(t), internal = join(root, ".ffa");
    await mkdir(internal);
    const path = join(internal, "workspace.json"), value = JSON.stringify(unsupported);
    const records = Buffer.from([0, 255, 17, 42]);
    await writeFile(path, value);
    await writeFile(join(internal, "records.bin"), records);
    await assert.rejects(state(root));
    await assert.rejects(begin(root));
    await assert.rejects(startInitialization(root, approveLocally));
    assert.throws(() => new Store(internal, false));
    assert.throws(() => new Store(internal));
    assert.equal(await readFile(path, "utf8"), value);
    assert.deepEqual(await readFile(join(internal, "records.bin")), records);
    assert.deepEqual((await readdir(internal)).sort(), ["records.bin", "workspace.json"]);
  });
}

test("initialization rejects directory aliases and paths outside the workspace", async t => {
  const root = await directory(t), outside = await directory(t);
  await symlink(outside, join(root, ".ffa"));
  await assert.rejects(begin(root));
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await mutationTarget(join(root, ".ffa/new-record")), join(outside, "new-record"));
});

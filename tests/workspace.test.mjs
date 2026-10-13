import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, mkdir, writeFile, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { begin, state } from "../dist/storage/workspace-state.js";
import { prepareWorkspace, documentsReady, finish, startInitialization } from "../dist/services/initialization-service.js";
import { mutationTarget } from "../dist/common/files.js";
import { approveLocally, localConfirmation } from "./helpers/local-confirmation.mjs";

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
  assert.equal((await state(root)).format, "ffa-pi/1");
  await prepareWorkspace(root);
  assert.deepEqual(await begin(root), await state(root));
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "User-owned instructions");
  await assert.rejects(documentsReady(root, ["market"]));
  await mkdir(join(root, "providers/market"));
  await writeFile(join(root, "providers/AGENTS.md"), "Provider index");
  await writeFile(join(root, "providers/market/GUIDE.md"), "Native API guide");
  await documentsReady(root, ["market"]);
  await finish(root, "market");
  assert.equal((await state(root)).status, "ready");
  await assert.rejects(finish(root, "other"));
});
test("confirmed initialization prepares a root entry before returning and preserves edits on resume", async t => {
  const root = await directory(t);
  const initial = await startInitialization(root, approveLocally);
  assert.equal(initial.status, "pending");
  const entry = join(root, "AGENTS.md");
  assert.ok((await stat(entry)).isFile());
  assert.ok((await stat(entry)).size > 0);
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
test("unsupported Pi workspace format is rejected without rewriting state", async t => {
  const root = await directory(t);
  await mkdir(join(root, ".ffa"));
  const path = join(root, ".ffa/workspace.json"), value = JSON.stringify({ format: "ffa-pi/3", status: "ready", market: "local" });
  await writeFile(path, value);
  await assert.rejects(state(root));
  await assert.rejects(begin(root));
  assert.equal(await readFile(path, "utf8"), value);
});

test("initialization rejects directory aliases and paths outside the workspace", async t => {
  const root = await directory(t), outside = await directory(t);
  await symlink(outside, join(root, ".ffa"));
  await assert.rejects(begin(root));
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await mutationTarget(join(root, ".ffa/new-record")), join(outside, "new-record"));
});

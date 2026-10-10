import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { locateWorkspace, readWorkspace, parseSetupDraft } from "../dist/infrastructure/workspace.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
const exec = promisify(execFile);
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), "ffa-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test("declining workspace creation leaves current directory untouched", async t => {
  const root = await temp(t);
  assert.equal(await locateWorkspace(root, async path => { assert.equal(path, root); return false; }), undefined);
  assert.deepEqual(await readdir(root), []);
});

test("creation is explicit, pending and isolated; directory aliases share ownership", async t => {
  const root = await temp(t);
  const directory = await locateWorkspace(root, async () => true);
  assert.deepEqual(await readWorkspace(directory), emptyWorkspace());
  const storage = await openApplicationStorage(directory);
  try {
    const alias = join(await temp(t), "alias");
    await symlink(root, alias, "dir");
    assert.equal(await locateWorkspace(alias, async () => assert.fail("must not ask again")), directory);
    await assert.rejects(openApplicationStorage(directory), { code: "INSTANCE_IN_USE" });
  } finally { await storage.close(); }
});

test("corrupt or symlinked workspace is never overwritten or treated as new", async t => {
  const root = await temp(t);
  await mkdir(join(root, ".ffa"));
  await writeFile(join(root, ".ffa", "config.json"), "broken");
  await assert.rejects(locateWorkspace(root, async () => assert.fail("must not ask")), { code: "WORKSPACE_INVALID" });
  assert.equal(await readFile(join(root, ".ffa", "config.json"), "utf8"), "broken");
  const other = await temp(t);
  await symlink(join(root, ".ffa"), join(other, ".ffa"));
  await assert.rejects(locateWorkspace(other, async () => true), { code: "WORKSPACE_INVALID" });
});

test("concurrent creation during confirmation cannot overwrite another workspace", async t => {
  const root = await temp(t);
  await assert.rejects(locateWorkspace(root, async () => {
    await locateWorkspace(root, async () => true);
    return true;
  }), { code: "WORKSPACE_CHANGED" });
  assert.deepEqual(await readWorkspace(join(root, ".ffa")), emptyWorkspace());
});

test("workspace drafts contain only sources; unsupported fields leave stored configuration intact", async t => {
  const source = { name: "行情", kind: "cli", location: "/test/quotes", description: "", missing: ["输入 schema"] };
  assert.deepEqual(parseSetupDraft({ sources: [source] }), { sources: [source] });
  for (const draft of [{ sources: [], objective: "研究" }, { sources: [{ ...source, discovery: { metadata: "forged" } }] }]) {
    assert.throws(() => parseSetupDraft(draft), { code: "WORKSPACE_INVALID" });
    const directory = await locateWorkspace(await temp(t), async () => true);
    const text = JSON.stringify({ ...emptyWorkspace(), draft });
    await writeFile(join(directory, "config.json"), text);
    await assert.rejects(readWorkspace(directory), { code: "WORKSPACE_INVALID" });
    assert.equal(await readFile(join(directory, "config.json"), "utf8"), text);
  }
});

test("noninteractive new-directory launch refuses creation and does not create model or workspace files", async t => {
  const root = await temp(t);
  await assert.rejects(exec(process.execPath, [new URL("../dist/main.js", import.meta.url).pathname, "--prompt", "hello"], {
    cwd: root, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
  }), error => error.stderr.includes("WORKSPACE_CONFIRMATION_REQUIRED"));
  assert.deepEqual(await readdir(root), []);
});

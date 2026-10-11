import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { locateWorkspace, readWorkspace, parseWorkspace, saveWorkspace } from "../dist/infrastructure/workspace.js";
import { seedWorkspaceDocuments } from "../dist/infrastructure/resources.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { WorkspaceServices } from "../dist/infrastructure/workspace-services.js";
import { TerminalApproval } from "../dist/interfaces/approval.js";
const exec = promisify(execFile);

test("initialization distinguishes missing, empty and unreadable required documents before confirmation", async t => {
  const root = await temp(t), directory = join(root, ".ffa");
  await mkdir(directory);
  await seedWorkspaceDocuments(root);
  await saveWorkspace(directory, { ...emptyWorkspace(), sources: { local: {
    connection: { transport: "cli", command: "/usr/bin/printf" },
    operations: [{ name: "print", access: "read", roles: ["coordinator"], schema: { type: "object", additionalProperties: false }, argv: ["local input"] }],
  } } });
  const approval = new TerminalApproval(undefined, false);
  const services = await WorkspaceServices.open(directory, approval.confirmAction.bind(approval));
  t.after(() => services.close());
  const observation = await services.read({ name: "local/print", parameters: {} });
  const evidence = { ref: "local-query", operation: "local/print", parameters: {}, success: observation.success,
    result: observation.data, binding: services.binding("local/print") };
  const finish = () => services.finish("test", evidence, evidence);
  const documents = ["sources/local/GUIDE.md", "AGENTS.md", "CLAUDE.md", "areas/AGENTS.md", "projects/AGENTS.md", "knowledge/AGENTS.md", "sources/AGENTS.md", ".agents/skills/AGENTS.md"].map(path => join(root, path));
  await mkdir(join(root, "sources", "local"), { recursive: true });
  for (const path of documents) await rm(path, { force: true });
  for (const path of documents) {
    await assert.rejects(finish(), { code: "SOURCE_GUIDE_REQUIRED" });
    await writeFile(path, " \n");
    await assert.rejects(finish(), { code: "SOURCE_GUIDE_REQUIRED" });
    await rm(path);
    await mkdir(path);
    await assert.rejects(finish(), { code: "SOURCE_GUIDE_UNREADABLE" });
    await rm(path, { recursive: true });
    await writeFile(path, "Local test document\n");
    assert.equal(services.initialized, false);
    assert.equal((await readWorkspace(directory)).initialization, null);
  }
  await assert.rejects(finish(), { code: "APPROVAL_NEEDS_TTY" });
});
test("configured reads run singly, in parallel and after reopen without interactive approval", async t => {
  const root = await temp(t), directory = join(root, ".ffa");
  await mkdir(directory);
  const query = { name: "print", access: "read", roles: ["coordinator"],
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    argv: ["%s", { parameter: "value" }] };
  await saveWorkspace(directory, { ...emptyWorkspace(), sources: { local: {
    connection: { transport: "cli", command: "/usr/bin/printf" },
    operations: [query, { ...query, name: "write", access: "write" }],
  } } });
  const approval = new TerminalApproval(undefined, false);
  for (let open = 0; open < 2; open++) {
    const services = await WorkspaceServices.open(directory, approval.confirmAction.bind(approval));
    try {
      const read = value => services.read({ name: "local/print", parameters: { value } });
      assert.equal((await read("single")).data, "single");
      const values = ["one", "two", "three"];
      const results = await Promise.all(values.map(read));
      assert.deepEqual(results.map(result => result.data), values);
      assert.ok(results.every(result => result.success));
      await assert.rejects(services.read({ name: "local/write", parameters: { value: "blocked" } }), { code: "OPERATION_DENIED" });
    } finally { await services.close(); }
  }
});

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
  const location = await locateWorkspace(root, async () => true), { directory } = location;
  assert.deepEqual(await readWorkspace(directory), emptyWorkspace());
  const storage = await openApplicationStorage(directory);
  try {
    const alias = join(await temp(t), "alias");
    await symlink(root, alias, "dir");
    assert.deepEqual(await locateWorkspace(alias, async () => assert.fail("must not ask again")), location);
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

test("old workspace formats and unsupported fields are rejected without data loss", async t => {
  for (const value of [{ version: 1, initialization: "pending", draft: { sources: [] } }, { ...emptyWorkspace(), version: 2 }, { ...emptyWorkspace(), objective: "research" }]) {
    assert.throws(() => parseWorkspace(value), { code: "WORKSPACE_INVALID" });
    const { directory } = await locateWorkspace(await temp(t), async () => true);
    const text = JSON.stringify(value);
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

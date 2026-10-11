import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMemory } from "../dist/infrastructure/workspace-memory.js";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, memory: new WorkspaceMemory(root) };
}

test("recall reads the only document source and reflects external edits without writing an index", async t => {
  const { root, memory } = await workspace(t);
  await mkdir(join(root, "areas"));
  await writeFile(join(root, "areas", "plan.md"), "scope: alpha\nlimit: 7\n");
  const before = await readdir(root);
  const result = await memory.list("limit");
  assert.deepEqual(result.entries.map(entry => entry.path), ["areas/plan.md"]);
  assert.equal(result.entries[0].line, 1);
  assert.equal(result.entries[0].excerpt, "scope: alpha\nlimit: 7\n");
  await writeFile(join(root, "areas", "plan.md"), "scope: beta\nlimit: 4\n");
  assert.equal((await memory.list("alpha")).entries.length, 0);
  assert.equal((await memory.list("beta")).entries[0].excerpt, "scope: beta\nlimit: 4\n");
  assert.deepEqual(await readdir(root), before);
});

test("search pagination counts matches and supports scoped path discovery", async t => {
  const { root, memory } = await workspace(t);
  await mkdir(join(root, "projects", "study"), { recursive: true });
  for (let i = 0; i < 65; i++) await writeFile(join(root, "projects", "study", `${String(i).padStart(2, "0")}.md`), i % 2 ? "unrelated" : "target");
  const first = await memory.list("target");
  assert.equal(first.entries.length, 30);
  assert.equal(first.nextOffset, 30);
  const second = await memory.list("target", first.nextOffset);
  assert.equal(second.entries.length, 3);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 33);
  const byPath = await memory.list("64.md", 0, "projects/study");
  assert.equal(byPath.entries[0].path, "projects/study/64.md");
  assert.equal((await memory.list("", 0, "projects/study/64.md")).entries.length, 1);
});

test("recall excludes hidden state, aliases and oversized files and rejects escaped scopes", async t => {
  const { root, memory } = await workspace(t), outside = await workspace(t);
  await mkdir(join(root, ".ffa"));
  await writeFile(join(root, ".ffa", "private.md"), "private");
  await mkdir(join(root, "knowledge"));
  await writeFile(join(root, "knowledge", "large.md"), "x".repeat(1024 * 1024 + 1));
  await writeFile(join(outside.root, "outside.md"), "private");
  await symlink(outside.root, join(root, "knowledge", "alias"));
  await symlink(join(outside.root, "outside.md"), join(root, "knowledge", "alias.md"));
  const result = await memory.list();
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.skipped.sort(), ["knowledge/alias", "knowledge/alias.md", "knowledge/large.md"]);
  assert.deepEqual((await memory.list("", 0, "knowledge/alias/outside.md")).entries, []);
  for (const scope of [".ffa", "../outside", "knowledge/../.ffa", "/knowledge", "knowledge/.hidden", "knowledge\\alias"]) {
    await assert.rejects(memory.list("", 0, scope), { code: "MEMORY_INVALID" });
  }
  await assert.rejects(memory.list("", -1), { code: "MEMORY_INVALID" });
});

test("recall searches only the shared skill subtree and never follows its parent alias", async t => {
  const { root, memory } = await workspace(t);
  await mkdir(join(root, ".agents", "skills", "local"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "local", "SKILL.md"), "search-target");
  await writeFile(join(root, ".agents", "private.md"), "search-target");
  await mkdir(join(root, ".claude"));
  await symlink("../.agents/skills", join(root, ".claude", "skills"));
  const expected = [".agents/skills/local/SKILL.md"];
  assert.deepEqual((await memory.list("search-target")).entries.map(item => item.path), expected);
  for (const scope of [".agents/skills", ".agents/skills/local", expected[0]]) {
    assert.deepEqual((await memory.list("search-target", 0, scope)).entries.map(item => item.path), expected);
  }
  for (const scope of [".agents", ".agents/private.md", ".agents/skills/../private.md", ".agents/skills/.hidden", ".claude/skills"]) {
    await assert.rejects(memory.list("", 0, scope), { code: "MEMORY_INVALID" });
  }
  const alias = await workspace(t);
  await symlink(join(root, ".agents"), join(alias.root, ".agents"));
  for (const scope of [undefined, ".agents/skills", ".agents/skills/local/SKILL.md"]) {
    const result = await alias.memory.list("search-target", 0, scope);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.skipped, [scope ?? ".agents/skills"]);
  }
});

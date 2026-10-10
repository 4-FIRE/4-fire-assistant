import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMemory } from "../dist/infrastructure/memory.js";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: root, memory: new WorkspaceMemory(join(root, "memory")) };
}

test("memory is Markdown with CAS updates, paging, immutable system receipts and symlink/path protection", async t => {
  const w = await workspace(t), first = await w.memory.save("明确的用户纠正", "preference");
  assert.equal((await stat(join(w.directory, "memory", "preference.md"))).mode & 0o777, 0o600);
  const attempts = await Promise.allSettled([w.memory.save("修改一", first.id, first.revision), w.memory.save("修改二", first.id, first.revision)]);
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  await assert.rejects(w.memory.save("覆盖", first.id));
  const system = await w.memory.record("source:exact-argv", "系统实际发现回执");
  await assert.rejects(w.memory.save("伪造", system.id, system.revision), { code: "MEMORY_INVALID" });
  await assert.rejects(w.memory.record("source:exact-argv", "另一份结果"), { code: "MEMORY_CHANGED" });
  const large = await w.memory.save("a".repeat(17000)), page = await w.memory.read(large.id);
  assert.equal(page.nextOffset, 16000); assert.equal((await w.memory.read(large.id, page.nextOffset, page.revision)).content.length, 1000);
  await assert.rejects(w.memory.read(large.id, page.nextOffset, "wrong"), { code: "MEMORY_CHANGED" });
  await assert.rejects(w.memory.save("bad", "../escape"), { code: "MEMORY_INVALID" });
  await symlink(join(w.directory, "config.json"), join(w.directory, "memory", "link.md")); await assert.rejects(w.memory.read("link"));
  const alias = join(w.root, "alias-memory"); await symlink(join(w.directory, "memory"), alias); await assert.rejects(new WorkspaceMemory(alias).save("bad"));
});

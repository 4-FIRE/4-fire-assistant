import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceSnapshot, seedWorkspaceDocuments, validateWorkspaceDocuments } from "../dist/infrastructure/resources.js";
import { fileMutationPolicy } from "../dist/infrastructure/file-tools.js";
import { can } from "../dist/application/permissions.js";
import { parseWorkspace } from "../dist/infrastructure/workspace.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), "ffa-resources-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
test("default roles and extension grants cannot exceed requested capabilities",async t=>{
  const directory = await temp(t);
  const defaults = ResourceSnapshot.defaults();
  assert.deepEqual(Object.keys(defaults.roles),["coordinator","researcher","reviewer"]);
  assert.throws(()=>defaults.instructions("strategy-maintainer/maintainer"),{code:"ROLE_DENIED"});
  const resources = await ResourceSnapshot.load(directory,{"strategy-maintainer":{maintainer:["read"]}});
  assert.equal(can("strategy-maintainer/maintainer","prepare",resources.roles),false);
  assert.equal(can("strategy-maintainer/maintainer","read",resources.roles),true);
  await assert.rejects(ResourceSnapshot.load(directory,{"strategy-maintainer":{maintainer:["execute"]}}),{code:"EXTENSION_INVALID"});
});
test("workspace grants and extension capabilities reject non-string values", async t => {
  const directory = await temp(t), root = join(directory, "extensions", "local");
  await mkdir(root, { recursive: true });
  for (const capability of [["read"], null, 1, {}]) {
    assert.throws(() => parseWorkspace({ ...emptyWorkspace(), extensions: { local: { reader: [capability] } } }), { code: "WORKSPACE_INVALID" });
    await writeFile(join(root, "extension.json"), JSON.stringify({ id: "local", version: 1,
      roles: [{ id: "reader", prompt: "reader.md", capabilities: [capability] }] }));
    await assert.rejects(ResourceSnapshot.load(directory, { local: {} }), { code: "EXTENSION_INVALID" });
  }
});

test("workspace documents are editable while internal state and outside aliases retain their boundaries",async t=>{
  const directory = await temp(t), outside = await temp(t);
  assert.equal(await fileMutationPolicy(directory,"projects/study/result.json"),"ordinary");
  assert.equal(await fileMutationPolicy(directory,"sources/provider/GUIDE.md"),"ordinary");
  for(const path of [".ffa", ".ffa/config.json", ".ffa/state.sqlite-wal", ".ffa/receipts/event.json"]) assert.equal(await fileMutationPolicy(directory,path),"state");
  for(const path of ["AGENTS.md","roles/researcher.md",".agents/skills/custom/SKILL.md"]) assert.equal(await fileMutationPolicy(directory,path),"ordinary");
  await mkdir(join(directory, ".ffa"));
  await writeFile(join(directory,".ffa", "config.json"),"{}");
  await symlink(join(directory,".ffa", "config.json"),join(directory,"alias.json"));
  assert.equal(await fileMutationPolicy(directory,"alias.json"),"state");
  await mkdir(join(directory,".agents"));
  await symlink(outside,join(directory,".agents","skills"));
  assert.equal(await fileMutationPolicy(directory,".agents/skills/custom/SKILL.md"),"confirm");
  await mkdir(join(directory,"extensions","local"),{recursive:true});
  await writeFile(join(directory,"extensions","local","extension.json"),JSON.stringify({id:"local",version:1,roles:[{id:"reader",prompt:"reader.md",capabilities:["read"]}]}));
  await symlink(join(directory,".ffa", "config.json"),join(directory,"extensions","local","reader.md"));
  await assert.rejects(ResourceSnapshot.load(directory,{local:{reader:["read"]}}),{code:"EXTENSION_INVALID"});
});


test("initialization creates usable entries, preserves existing data and is idempotent", async t => {
  const root = await temp(t);
  const existing = "User-owned data\n";
  await writeFile(join(root, "AGENTS.md"), existing);
  await writeFile(join(root, "README.md"), existing);
  await seedWorkspaceDocuments(root);
  await validateWorkspaceDocuments(root);
  const before = await readdir(root);
  await seedWorkspaceDocuments(root);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), existing);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), existing);
  assert.equal(before.includes(".ffa"), false);
  await rm(join(root, "knowledge"), { recursive: true });
  await symlink(await temp(t), join(root, "knowledge"));
  await assert.rejects(seedWorkspaceDocuments(root), { code: "RESOURCE_SYMLINK" });
});

test("shared skills and the Claude alias resolve to the same portable files", async t => {
  const root = await temp(t);
  await seedWorkspaceDocuments(root);
  assert.equal((await readdir(root)).includes("README.md"), false);
  assert.equal((await readdir(root)).includes("skills"), false);
  assert.equal(await readlink(join(root, ".claude", "skills")), "../.agents/skills");
  const skill = join(root, ".agents", "skills", "local");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\nname: local\ndescription: Local fixture\n---\n");
  const shared = loadSkillsFromDir({ dir: join(root, ".agents", "skills"), source: "workspace" });
  const alias = loadSkillsFromDir({ dir: join(root, ".claude", "skills"), source: "workspace" });
  assert.deepEqual(shared.skills.map(item => item.name), ["local"]);
  assert.deepEqual(alias.skills.map(item => item.name), ["local"]);
  assert.equal(await realpath(shared.skills[0].filePath), await realpath(alias.skills[0].filePath));
  assert.equal(await fileMutationPolicy(root, ".claude/skills/local/SKILL.md"), "ordinary");
});

test("initialization preserves existing Claude entries and does not write through hidden parent aliases", async t => {
  const root = await temp(t);
  await mkdir(join(root, ".claude", "skills", "existing"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "User-owned adapter\n");
  await writeFile(join(root, ".claude", "skills", "existing", "SKILL.md"), "User-owned skill\n");
  await seedWorkspaceDocuments(root);
  await validateWorkspaceDocuments(root);
  assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), "User-owned adapter\n");
  assert.equal(await readFile(join(root, ".claude", "skills", "existing", "SKILL.md"), "utf8"), "User-owned skill\n");
  for (const name of [".agents", ".claude"]) {
    const workspace = await temp(t), outside = await temp(t);
    await symlink(outside, join(workspace, name));
    await assert.rejects(seedWorkspaceDocuments(workspace), { code: "RESOURCE_SYMLINK" });
    assert.deepEqual(await readdir(outside), []);
  }
});

test("refresh retains grants and rejects a changed extension role set", async t => {
  const root = await temp(t), extension = join(root, "extensions", "local");
  await mkdir(extension, { recursive: true });
  const manifest = { id: "local", version: 1, roles: [{ id: "reader", prompt: "reader.md", capabilities: ["read"] }] };
  await writeFile(join(extension, "extension.json"), JSON.stringify(manifest));
  await writeFile(join(extension, "reader.md"), "Local instructions");
  const resources = await ResourceSnapshot.load(root, { local: { reader: ["read"] } });
  const refreshed = await resources.refresh();
  assert.deepEqual(refreshed.roles, resources.roles);
  assert.notEqual(refreshed, resources);
  manifest.roles[0].capabilities = [];
  await writeFile(join(extension, "extension.json"), JSON.stringify(manifest));
  await assert.rejects(resources.refresh(), { code: "EXTENSION_INVALID" });
});

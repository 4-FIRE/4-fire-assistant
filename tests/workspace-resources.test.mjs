import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceSnapshot } from "../dist/infrastructure/resources.js";
import { fileMutationPolicy } from "../dist/infrastructure/file-tools.js";
import { can } from "../dist/application/permissions.js";
import { parseWorkspace } from "../dist/infrastructure/workspace.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";

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

test("ordinary files, state and long-term instructions use distinct write policies, including aliases",async t=>{
  const directory = await temp(t), outside = await temp(t);
  assert.equal(await fileMutationPolicy(directory,"projects/study/result.json"),"ordinary");
  assert.equal(await fileMutationPolicy(directory,"sources/provider/GUIDE.md"),"ordinary");
  for(const path of ["config.json","state.sqlite-wal","memory/entry.md"]) assert.equal(await fileMutationPolicy(directory,path),"state");
  for(const path of ["AGENTS.md","roles/researcher.md","skills/custom/SKILL.md"]) assert.equal(await fileMutationPolicy(directory,path),"confirm");
  await writeFile(join(directory,"config.json"),"{}");
  await symlink(join(directory,"config.json"),join(directory,"alias.json"));
  assert.equal(await fileMutationPolicy(directory,"alias.json"),"state");
  await symlink(outside,join(directory,"skills"));
  assert.equal(await fileMutationPolicy(directory,"skills/custom/SKILL.md"),"confirm");
  await mkdir(join(directory,"extensions","local"),{recursive:true});
  await writeFile(join(directory,"extensions","local","extension.json"),JSON.stringify({id:"local",version:1,roles:[{id:"reader",prompt:"reader.md",capabilities:["read"]}]}));
  await symlink(join(directory,"config.json"),join(directory,"extensions","local","reader.md"));
  await assert.rejects(ResourceSnapshot.load(directory,{local:{reader:["read"]}}),{code:"EXTENSION_INVALID"});
});

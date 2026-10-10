import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceSnapshot } from "../dist/infrastructure/resources.js";
import { can } from "../dist/application/permissions.js";

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
test("extension files are data; unknown resource overrides and symlinks fail closed",async t=>{
  const directory = await temp(t);
  await mkdir(join(directory,"resources"));
  await symlink("/etc/passwd",join(directory,"resources","reference.md"));
  await assert.rejects(ResourceSnapshot.load(directory),{code:"RESOURCE_SYMLINK"});
  await rm(join(directory,"resources","reference.md"));
  await writeFile(join(directory,"resources","new.md"),"unknown");
  await assert.rejects(ResourceSnapshot.load(directory),{code:"RESOURCE_UNKNOWN"});
});

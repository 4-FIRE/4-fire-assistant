import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec=promisify(execFile);
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const cli=join(root,"dist/main.js");
async function temp(t) {const path=await mkdtemp(join(tmpdir(),"4fire-distribution-"));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
function isolatedEnv(directory) {return {PATH:process.env.PATH,HOME:directory,USERPROFILE:directory,XDG_CONFIG_HOME:directory,PI_CODING_AGENT_DIR:join(directory,"pi"),AWS_EC2_METADATA_DISABLED:"true"};}
test("help/version do not create application data; CLI errors never print secret arguments",async t=>{
  const directory=await temp(t);
  const env=isolatedEnv(directory);
  await exec(process.execPath,[cli,"--help"],{cwd:directory,env});
  await exec(process.execPath,[cli,"--version"],{cwd:directory,env});
  assert.deepEqual(await readdir(directory),[]);
  await assert.rejects(exec(process.execPath,[cli,"--unknown-secret-option","credential-secret"],{cwd:directory,env}),error=>!error.stderr.includes("credential-secret")&&error.stderr.includes("INVALID_ARGUMENTS"));
});
test("CLI rejects relative credential paths before creating ModelRuntime",async t=>{
  const directory=await temp(t);
  await assert.rejects(exec(process.execPath,[cli,"--data-dir",directory,"--auth-file","relative-secret"],{env:isolatedEnv(directory)}),error=>error.stderr.includes("INVALID_CONFIG")&&!error.stderr.includes("relative-secret"));
  assert.ok(!(await readdir(directory)).includes("pi"));
});
test("interactive configuration requires a TTY and rejects conflicting modes",async t=>{
  const directory=await temp(t),env=isolatedEnv(directory);
  await assert.rejects(exec(process.execPath,[cli,"--data-dir",directory,"--configure"],{env}),error=>error.stderr.includes("CONFIGURE_NEEDS_TTY"));
  await assert.rejects(exec(process.execPath,[cli,"--data-dir",directory,"--configure","--prompt","fixture"],{env}),error=>error.stderr.includes("INVALID_ARGUMENTS"));
  assert.ok(!(await readdir(directory)).includes("config.local.json"));
  assert.ok(!(await readdir(directory)).includes("pi"));
});
test("configuration command preserves invalid input and never initializes real credentials or services",async t=>{
 const directory=await temp(t),data=join(directory,"data"),source=join(directory,"config.json"),env=isolatedEnv(directory);
 await writeFile(source,JSON.stringify({version:1,model:{provider:"openai",modelId:"gpt-4.1"},thinkingLevel:"off"}));
 await exec(process.execPath,[cli,"--data-dir",data,"--configure-file",source],{env});
 const saved=JSON.parse(await readFile(join(data,"config.local.json"),"utf8"));
 assert.equal(saved.model.modelId,"gpt-4.1");assert.ok(!(await readdir(directory)).includes("pi"));
 await writeFile(source,JSON.stringify({version:1,credential:"credential-secret"}));
 await assert.rejects(exec(process.execPath,[cli,"--data-dir",data,"--configure-file",source],{env}),e=>e.stderr.includes("INVALID_CONFIG")&&!e.stderr.includes("credential-secret"));
 assert.deepEqual(JSON.parse(await readFile(join(data,"config.local.json"),"utf8")),saved);
});

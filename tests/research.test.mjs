import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Research } from "../dist/infrastructure/research.js";
import { WorkspaceMemory } from "../dist/infrastructure/memory.js";
async function temp(t) {
  const directory=await mkdtemp(join(tmpdir(),"ffa-research-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));return directory;
}
const runtimeDirectory=process.env.FFA_TEST_RUNTIME;
const bars=Array.from({length:90},(_,i)=>({date:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),
  open:10+i/10,high:11+i/10,low:9+i/10,close:10.5+i/10,volume:100000}));
const context={symbol:"FIXTURE",market:"CN-A",currency:"CNY",adjustment:"none",source:"fixed-test",obtainedAt:"2025-04-01"};
test("research knowledge uses memory; computation records reject paths outside experiments", async t => {
  const root = await temp(t), research = new Research(root, { runtimeDirectory: join(root, "missing") });
  const memory = new WorkspaceMemory(join(root, ".ffa", "memory"));
  assert.equal((await research.status()).available, false);
  const saved = await memory.save("研究项目 example：结论");
  assert.equal((await memory.read(saved.id)).content, "研究项目 example：结论");
  assert.equal((await memory.list("研究项目 example")).entries.length, 1);
  const runs = join(root, "projects", "example", "runs");
  await mkdir(join(runs, "fixture"), { recursive: true });
  await writeFile(join(runs, "fixture", "result.json"), '{"status":"ok"}');
  assert.deepEqual(await research.list(), ["example"]);
  assert.deepEqual(await research.list("example"), { runs: ["fixture"] });
  assert.equal((await research.read("example", "fixture")).text, '{"status":"ok"}');
  await assert.rejects(research.read("example", "../outside"));
  await assert.rejects(research.read("example", "fixture", "strategy.py"));
  assert.deepEqual(await research.list("missing"), []);
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, "projects", "escape"));
  await assert.rejects(research.read("escape", "fixture"));
  await symlink(join(root, "outside"), join(runs, "escape"));
  await assert.rejects(research.read("example", "escape"));
  await symlink(join(runs, "fixture", "result.json"), join(runs, "fixture", "manifest.json"));
  await assert.rejects(research.read("example", "fixture", "manifest.json"));
});
test("real shared Python computes indicators and backtests; workspaces retain independent experiments",
  {skip:!runtimeDirectory && "Set FFA_TEST_RUNTIME to an installed managed runtime"},async t=>{
  const a=await temp(t),b=await temp(t),first=new Research(a,{runtimeDirectory}),second=new Research(b,{runtimeDirectory});
  assert.deepEqual(await first.status(),{available:true,mode:"python"});
  const request={version:1,operation:"indicators",context,bars,parameters:{period:5}};
  const run=await first.run({project:"study",request,evidence:[]});
  assert.equal(run.result.status,"ok");
  assert.equal(run.result.series.sma[4],10.7);
  const manifest=JSON.parse(await readFile(join(a,run.path,"manifest.json"),"utf8"));
  assert.equal(manifest.mode,"python");assert.equal(manifest.isolation,"none");assert.equal(manifest.state,"completed");
  const strategy="from backtesting import Strategy as Base\nclass Strategy(Base):\n def init(self): pass\n def next(self):\n  if len(self.data)==2: self.buy(size=100)\n  if len(self.data)==8: self.position.close()\n";
  const backtest=await second.run({project:"study",request:{...request,operation:"backtest",parameters:{}},strategy,evidence:[]});
  assert.equal(backtest.result.status,"ok");assert.ok(backtest.result.trades.length);
  assert.deepEqual(Object.keys(backtest.result.metrics),["full","is","oos"]);
  assert.equal((await readdir(join(a,"projects","study","runs"))).length,1);
  assert.equal((await readdir(join(b,"projects","study","runs"))).length,1);
  assert.equal(await readFile(join(b,backtest.path,"inputs","strategy.py"),"utf8"),strategy);
  const bad=await second.run({project:"study",request:{...request,bars:[bars[0],bars[0],bars[1],bars[2]]},evidence:[]});
  assert.equal(bad.result.status,"error");
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(first.run({project:"study",request,evidence:[]},cancelled.signal));
});

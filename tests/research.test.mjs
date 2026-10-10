import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Research } from "../dist/infrastructure/research.js";
const exec = promisify(execFile);
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), "ffa-research-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("ordinary Python retains inputs, results and failed runs in independent workspaces", { timeout: 60_000 }, async t => {
  const root = await temp(t), runtimeDirectory = join(root, "runtime");
  await exec("python3", ["-I", "-m", "venv", "--without-pip", runtimeDirectory]);
  const python = join(runtimeDirectory, "bin", "python");
  const pythonVersion = (await exec(python, ["-I", "-c", "import sys;print(sys.version)"])).stdout.trim();
  await writeFile(join(runtimeDirectory, "runtime.json"), JSON.stringify({ version: "0.2.0", python, pythonVersion }));
  const a = join(root, "a"), b = join(root, "b");
  await mkdir(a); await mkdir(b);
  const first = new Research(a, { runtimeDirectory }), second = new Research(b, { runtimeDirectory });
  assert.deepEqual(await first.status(), { available: true, mode: "python" });
  const code = "import json,math\nfrom pathlib import Path\ndata=json.loads(Path('inputs.json').read_text())\nPath('result.json').write_text(json.dumps({'total':math.fsum(data)}))\nprint(json.dumps({'count':len(data)}))\n";
  const inputs = [1, 2, 3.5];
  const run = await first.run({ project: "study", code, inputs, evidence: [] });
  assert.equal(run.state, "completed");
  assert.equal(run.exitCode, 0);
  assert.deepEqual(JSON.parse(run.stdout), { count: 3 });
  assert.deepEqual(JSON.parse(await readFile(join(a, run.path, "result.json"), "utf8")), { total: 6.5 });
  assert.deepEqual(JSON.parse(await readFile(join(a, run.path, "inputs.json"), "utf8")), inputs);
  assert.equal(await readFile(join(a, run.path, "main.py"), "utf8"), code);
  assert.equal((await first.list("study")).runs[0].state, "completed");
  assert.deepEqual(await second.list(), []);
  const bad = await second.run({ project: "study", code: "raise ValueError('calculation failed')", inputs: null, evidence: [] });
  assert.equal(bad.state, "failed");
  assert.notEqual(bad.exitCode, 0);
  assert.equal((await readdir(join(a, "projects", "study", "runs"))).length, 1);
  assert.equal((await readdir(join(b, "projects", "study", "runs"))).length, 1);

  const abort = new AbortController();
  const running = first.run({ project: "cancel", code: "import time\nprint(7,flush=True)\ntime.sleep(30)", inputs: null, evidence: [] }, abort.signal);
  let runPath;
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = await first.list("cancel");
    if (rows.runs[0]?.state === "running") {
      runPath = join(a, "projects", "cancel", "runs", rows.runs[0].id);
      try { if ((await readFile(join(runPath, "stdout.txt"), "utf8")).trim()) break; } catch {}
    }
    await delay(10);
  }
  abort.abort();
  const cancelled = await running;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(JSON.parse(await readFile(join(runPath, "stdout.txt"), "utf8")), 7);
  assert.equal(JSON.parse(await readFile(join(runPath, "manifest.json"), "utf8")).state, "cancelled");
  await symlink(b, join(a, "projects", "escape"));
  await assert.rejects(first.run({ project: "escape", code: "print(1)", inputs: null, evidence: [] }));
  await assert.rejects(first.run({ project: "../escape", code: "print(1)", inputs: null, evidence: [] }));
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(first.run({ project: "never-started", code: "print(1)", inputs: null, evidence: [] }, stopped.signal));
  assert.equal((await first.list()).includes("never-started"), false);

  const child = fork(new URL("./helpers/research-owner.mjs", import.meta.url), [a, runtimeDirectory], {
    execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => child.kill("SIGKILL"));
  let interruptedPath;
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = await first.list("interrupted");
    if (rows.runs[0]?.recordedState === "running") {
      const path = join(a, "projects", "interrupted", "runs", rows.runs[0].id);
      try { if ((await readFile(join(path, "stdout.txt"), "utf8")).trim()) { interruptedPath = path; break; } } catch {}
    }
    await delay(10);
  }
  assert.ok(interruptedPath);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const reopened = new Research(a, { runtimeDirectory });
  const preserved = (await reopened.list("interrupted")).runs;
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].state, "interrupted");
  assert.equal(preserved[0].recordedState, "running");
  assert.deepEqual(JSON.parse(await readFile(join(interruptedPath, "inputs.json"), "utf8")), { experiment: 1 });
  assert.equal(JSON.parse(await readFile(join(interruptedPath, "stdout.txt"), "utf8")), 17);
});

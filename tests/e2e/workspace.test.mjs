import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rpcWorkspace } from "../helpers/pi-rpc.mjs";

const readJson = async path => JSON.parse(await readFile(path, "utf8"));

test("E2E: initialization resumes only on request, reload enables tools, and Python artifacts survive restart", { timeout: 60_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  let pi = await workspace.start();
  assert.deepEqual((await pi.inspect()).tools.filter(name => name.startsWith("ffa_")), []);

  await pi.confirm(() => pi.command("/ffa init"), false);
  assert.deepEqual(await readdir(workspace.root), []);
  await pi.confirm(() => pi.command("/ffa init"));
  await pi.driver("idle");
  const statePath = join(workspace.root, ".ffa/workspace.json");
  assert.equal((await readJson(statePath)).status, "pending");
  const pending = await pi.inspect();
  assert.ok(pending.tools.includes("ffa_finish_initialization"));
  assert.ok(!pending.tools.includes("ffa_python"));
  const documents = "# User workspace\n\nKeep these research notes across initialization and restart.\n";
  await writeFile(join(workspace.root, "AGENTS.md"), documents);
  await assert.rejects(pi.confirm(() => pi.tool("ffa_finish_initialization"), false));
  assert.equal((await readJson(statePath)).status, "pending");
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  pi = await workspace.start();
  assert.deepEqual((await pi.inspect()).tools.filter(name => name.startsWith("ffa_")), []);
  assert.equal((await readJson(statePath)).status, "pending");
  await pi.confirm(() => pi.command("/ffa init"));
  await pi.driver("idle");
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  assert.equal((await pi.confirm(() => pi.tool("ffa_finish_initialization"))).ready, true);
  await pi.command("/ffa init");
  const ready = await pi.inspect();
  assert.ok(ready.tools.includes("ffa_python"));
  assert.ok(!ready.tools.includes("ffa_finish_initialization"));
  assert.ok(ready.skills.length > 0);
  assert.deepEqual((await pi.tool("ffa_status")).workspace, { format: "ffa/0.3", status: "ready" });
  assert.deepEqual((await pi.tool("ffa_providers")).providers, []);
  assert.deepEqual(await readJson(join(workspace.root, ".ffa/permissions.json")), { default: "ask", tools: {} });

  const code = "import json\nfrom pathlib import Path\nvalues = json.loads(Path('inputs.json').read_text())['values']\nprint(json.dumps({'total': sum(values)}))";
  const inputs = { values: [7, 11, 24] };
  const run = await pi.tool("ffa_python", { code, inputs, owner: "projects/local-research" });
  assert.equal(run.state, "completed");
  assert.deepEqual(run.output, { total: 42 });
  const directory = join(workspace.root, run.path);
  assert.equal(await readFile(join(directory, "main.py"), "utf8"), code);
  assert.deepEqual(await readJson(join(directory, "inputs.json")), inputs);
  const manifest = await readJson(join(directory, "manifest.json"));
  assert.equal(manifest.state, "completed");
  assert.ok(manifest.finishedAt);
  assert.equal((await readJson(join(directory, "process.json"))).exitCode, 0);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  pi = await workspace.start();
  assert.equal((await pi.tool("ffa_status")).workspace.status, "ready");
  assert.deepEqual(await readJson(join(directory, "output.json")), run.output);
  assert.deepEqual(await readJson(join(directory, "manifest.json")), manifest);
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  assert.deepEqual(await readdir(join(workspace.root, ".ffa/calls")), []);
  assert.deepEqual(await readdir(join(workspace.root, "projects/local-research/runs")), [run.id]);
});

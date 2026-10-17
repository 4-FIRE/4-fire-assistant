import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rpcWorkspace } from "../helpers/pi-rpc.mjs";

const readJson = async path => JSON.parse(await readFile(path, "utf8"));

test("E2E: startup reports a damaged Python environment, preserves history and leaves native Bash available", { timeout: 60_000 }, async t => {
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
  assert.ok(!ready.tools.includes("ffa_python"));
  assert.ok(!ready.tools.includes("ffa_finish_initialization"));
  assert.ok(ready.skills.length > 0);
  assert.deepEqual((await pi.tool("ffa_status")).workspace, { format: "ffa/0.3", status: "ready" });
  assert.deepEqual((await pi.tool("ffa_providers")).providers, []);
  assert.deepEqual(await readJson(join(workspace.root, ".ffa/permissions.json")), { default: "ask", tools: {} });

  await assert.rejects(pi.execute("ffa_python", { code: "print(42)" }));
  await assert.rejects(readdir(join(workspace.root, "scratch/runs")), { code: "ENOENT" });
  const settingsPath = join(workspace.root, ".ffa/settings.json");
  const settings = JSON.stringify({ python: "/previous/environment/bin/python" });
  await writeFile(settingsPath, settings);
  const history = join(workspace.root, "scratch/runs/previous");
  await mkdir(history, { recursive: true });
  const historicalCode = "print(42)\n", historicalOutput = '{"stdout":"42\\n"}\n';
  await writeFile(join(history, "main.py"), historicalCode);
  await writeFile(join(history, "output.json"), historicalOutput);

  assert.ok(pi.records.some(record => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "warning"));
  await pi.command("/ffa status");
  const status = pi.records.findLast(record => record.type === "extension_ui_request" && record.method === "notify");
  assert.equal(JSON.parse(status.message).python.state, "error");
  await pi.command("/ffa python setup");
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.deepEqual(await readdir(join(workspace.temp, "home/data/ffa/python/.venv")), []);
  // The removed interpreter-binding command cannot alter existing settings.
  await pi.command("/ffa python /usr/bin/python3");
  const requests = pi.records.filter(record => record.type === "extension_ui_request" && record.method === "confirm").length;
  await pi.command("/ffa python setup /usr/bin/python3");
  assert.equal(pi.records.filter(record => record.type === "extension_ui_request" && record.method === "confirm").length, requests);
  assert.equal(await readFile(settingsPath, "utf8"), settings);

  const project = join(workspace.root, "projects/local-research");
  await mkdir(project, { recursive: true });
  const code = "import json,sys\nfrom pathlib import Path\nfrom calculation import total\nvalues=json.loads(Path('inputs.json').read_text())\nresult={'total':total(values), 'args':sys.argv[1:]}\nPath('output.json').write_text(json.dumps(result))\nprint(json.dumps(result))";
  await writeFile(join(project, "analyze.py"), code);
  await writeFile(join(project, "calculation.py"), "def total(values): return sum(values)\n");
  await writeFile(join(project, "inputs.json"), JSON.stringify([7, 11, 24]));
  const result = await pi.execute("bash", {
    command: "cd " + JSON.stringify(project) + " && python3 analyze.py --window 20",
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const output = { total: 42, args: ["--window", "20"] };
  assert.deepEqual(JSON.parse(result.content.find(part => part.type === "text").text), output);
  assert.deepEqual(await readJson(join(project, "output.json")), output);
  assert.equal(await readFile(join(project, "analyze.py"), "utf8"), code);
  assert.deepEqual(await readdir(join(workspace.root, "scratch/runs")), ["previous"]);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  pi = await workspace.start();
  assert.equal((await pi.tool("ffa_status")).workspace.status, "ready");
  assert.ok(!(await pi.inspect()).tools.includes("ffa_python"));
  assert.deepEqual(await readJson(join(project, "output.json")), output);
  assert.equal(await readFile(join(history, "main.py"), "utf8"), historicalCode);
  assert.equal(await readFile(join(history, "output.json"), "utf8"), historicalOutput);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  assert.deepEqual(await readdir(join(workspace.root, ".ffa/calls")), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot, rpcWorkspace } from "../helpers/pi-rpc.mjs";
import { begin } from "../../dist/storage/workspace-state.js";
import { finish } from "../../dist/services/workspace/initialization-service.js";

const exec = promisify(execFile);

test("smoke: source package registers commands without activating an uninitialized workspace", { timeout: 30_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  const pi = await workspace.start();
  const { commands } = await pi.request("get_commands");
  assert.ok(commands.some(command => command.name === "ffa"));
  const resources = await pi.inspect();
  assert.deepEqual(resources.tools.filter(name => name.startsWith("ffa_")), []);
  assert.deepEqual(resources.skills, []);
  await pi.command("/ffa status");
  await pi.command("/ffa update");
  assert.deepEqual(await readdir(workspace.root), []);
  assert.ok(!pi.records.some(record => record.type === "extension_error"));
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});

test("smoke: pending workspaces stay inactive and startup leaves saved state unchanged", { timeout: 30_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  await begin(workspace.root);
  const path = join(workspace.root, ".ffa/workspace.json");
  const before = await readFile(path, "utf8");
  const files = await readdir(join(workspace.root, ".ffa"));
  const pi = await workspace.start();
  assert.deepEqual((await pi.inspect()).tools.filter(name => name.startsWith("ffa_")), []);
  await pi.command("/ffa status");
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(join(workspace.root, ".ffa")), files);
  assert.ok(!pi.records.some(record => record.type === "extension_error"));
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});

test("smoke: unsupported workspaces stay inactive and commands cannot convert or overwrite them", { timeout: 30_000 }, async t => {
  const workspace = await rpcWorkspace(t), internal = join(workspace.root, ".ffa");
  await mkdir(internal);
  const value = JSON.stringify({ format: "ffa-pi/1", status: "ready" });
  const records = Buffer.from([0, 255, 17, 42]);
  await writeFile(join(internal, "workspace.json"), value);
  await writeFile(join(internal, "records.bin"), records);
  const pi = await workspace.start();
  assert.deepEqual((await pi.inspect()).tools.filter(name => name.startsWith("ffa_")), []);
  await pi.command("/ffa update");
  await pi.command("/ffa init");
  assert.deepEqual((await pi.inspect()).tools.filter(name => name.startsWith("ffa_")), []);
  assert.equal(await readFile(join(internal, "workspace.json"), "utf8"), value);
  assert.deepEqual(await readFile(join(internal, "records.bin")), records);
  assert.deepEqual((await readdir(internal)).sort(), ["records.bin", "workspace.json"]);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});

test("smoke: packed sources load ready tools and the standalone setup script without a dist directory", { timeout: 60_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  const { temp } = workspace;
  const { stdout } = await exec("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", temp], {
    cwd: packageRoot, timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: temp, LANG: "C.UTF-8", npm_config_cache: join(temp, "cache") },
  });
  const [{ filename }] = JSON.parse(stdout);
  await exec("tar", ["-xzf", join(temp, filename), "-C", temp], { timeout: 10_000 });
  const packed = join(temp, "package");
  await exec(process.execPath, [join(packed, "scripts/upgrade-0.3.0.mjs")], { cwd: workspace.root });
  const plan = await exec("/usr/bin/python3", ["-I", "-B", join(packed, "scripts/setup-python.py"), "--check"],
    { env: { HOME: temp, XDG_DATA_HOME: join(temp, "empty-data") } });
  assert.equal(JSON.parse(plan.stdout).python, join(temp, "empty-data/ffa/python/.venv/bin/python"));
  await assert.rejects(readdir(join(temp, "empty-data")), { code: "ENOENT" });
  assert.deepEqual(await readdir(workspace.root), []);
  // Supply the already installed locked dependencies; do not download or install packages.
  await symlink(join(packageRoot, "node_modules"), join(packed, "node_modules"), "dir");
  await assert.rejects(readdir(join(packed, "dist")), { code: "ENOENT" });
  await begin(workspace.root);
  await writeFile(join(workspace.root, ".ffa/permissions.json"), JSON.stringify({ default: "ask", tools: {} }));
  await finish(workspace.root);
  const pi = await workspace.start(packed);
  const resources = await pi.inspect();
  for (const name of ["ffa_status", "ffa_providers", "ffa_agent"]) assert.ok(resources.tools.includes(name));
  assert.ok(resources.skills.length > 0);
  assert.equal((await pi.tool("ffa_status")).workspace.status, "ready");
  assert.deepEqual((await pi.tool("ffa_providers")).providers, []);
  assert.ok((await pi.tool("ffa_agent", { action: "list" })).agents.length > 0);
  assert.ok(!resources.tools.includes("ffa_python"));
  assert.ok(!pi.records.some(record => record.type === "extension_error"));
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});

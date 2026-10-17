import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { PythonEnvironmentService } from "../../dist/services/workspace/python-environment-service.js";
import { activatePython } from "../../dist/integrations/python-activation.js";

const exec = promisify(execFile);
const script = resolve("scripts/setup-python.py"), python = "/usr/bin/python3";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa shared python "));
  const environment = { HOME: root, PATH: "/usr/bin:/bin", XDG_DATA_HOME: join(root, "data") };
  const directory = join(environment.XDG_DATA_HOME, "ffa/python/.venv");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, environment };
}

async function check(environment) {
  const result = await exec(python, ["-I", "-B", script, "--check"], { env: environment });
  return JSON.parse(result.stdout);
}

function useEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("read-only checks resolve one user environment without creating it", async t => {
  const { root, directory, environment } = await fixture(t);
  const proposed = await check(environment);
  assert.equal(proposed.directory, directory);
  assert.equal(proposed.current, null);
  assert.equal(proposed.python, join(directory, "bin/python"));
  assert.ok(proposed.required["ta-lib"]);
  assert.deepEqual(await readdir(root), []);
  for (const data of ["", "relative"]) {
    assert.equal((await check({ ...environment, XDG_DATA_HOME: data })).directory, join(root, ".local/share/ffa/python/.venv"));
  }
});

test("setup preserves unrelated files and rejects a symlink environment", async t => {
  const { root, directory, environment } = await fixture(t);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "notes"), "keep");
  await assert.rejects(exec(python, ["-I", "-B", script], { env: environment }));
  assert.equal(await readFile(join(directory, "notes"), "utf8"), "keep");
  const aliasData = join(root, "alias-data");
  await mkdir(join(aliasData, "ffa/python"), { recursive: true });
  await symlink(directory, join(aliasData, "ffa/python/.venv"));
  await assert.rejects(check({ ...environment, XDG_DATA_HOME: aliasData }));
  assert.equal(await readFile(join(directory, "notes"), "utf8"), "keep");
});

test("check identifies the actual venv and rejects inherited system packages", async t => {
  const { directory, environment } = await fixture(t);
  await exec(python, ["-m", "venv", "--without-pip", directory]);
  const proposed = await check(environment);
  assert.equal(proposed.current.prefix, directory);
  assert.deepEqual(proposed.current.packages, {});
  const config = join(directory, "pyvenv.cfg");
  await writeFile(config, (await readFile(config, "utf8")).replace("include-system-site-packages = false", "include-system-site-packages = true"));
  await assert.rejects(check(environment));
});

test("setup waits for another installer and close cancels the wait without activation", async t => {
  const { root, directory, environment } = await fixture(t);
  await mkdir(join(directory, ".."), { recursive: true });
  const child = spawn(python, ["-I", "-B", "-c",
    "import fcntl,sys\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('ready',flush=True)\nsys.stdin.read()", directory + ".lock"]);
  const stopped = new Promise(resolve => child.on("close", resolve));
  t.after(async () => { child.stdin.end(); await stopped; });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  useEnvironment(t, environment);
  const before = process.env.VIRTUAL_ENV;
  const service = new PythonEnvironmentService(root);
  const pending = service.setup(), rejected = assert.rejects(pending);
  assert.equal(service.setup(), pending);
  assert.equal(service.status.state, "preparing");
  await service.close();
  await rejected;
  assert.equal(service.status.state, "error");
  assert.equal(process.env.VIRTUAL_ENV, before);
  await assert.rejects(access(directory), { code: "ENOENT" });
  await assert.rejects(service.setup());
});

test("a damaged environment is reported without changing process Python or workspace files", async t => {
  const { root, directory, environment } = await fixture(t);
  await mkdir(directory, { recursive: true });
  useEnvironment(t, environment);
  const before = process.env.PATH;
  const service = new PythonEnvironmentService(root);
  await assert.rejects(service.setup());
  assert.equal(service.status.state, "error");
  assert.equal(typeof service.status.error, "string");
  assert.equal(process.env.PATH, before);
  assert.deepEqual(await readdir(directory), []);
  await service.close();
});

test("native Pi Bash inherits activated python and python3 and close restores the process environment", async t => {
  const { root, directory } = await fixture(t);
  await exec(python, ["-m", "venv", "--without-pip", directory]);
  useEnvironment(t, { PYTHONHOME: "/unrelated/python", PYTHONPATH: "/unrelated/modules" });
  const keys = ["PATH", "VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "PYTHONNOUSERSITE"];
  const before = keys.map(key => process.env[key]);
  const restore = activatePython(directory);
  try {
    const bash = createBashTool(root);
    for (const command of ["python", "python3"]) {
      const result = await bash.execute(command, { command: command + " -c 'import json,os,site,sys; print(json.dumps([sys.prefix,os.environ.get(\"VIRTUAL_ENV\"),site.ENABLE_USER_SITE]))'" });
      assert.deepEqual(JSON.parse(result.content.find(part => part.type === "text").text), [directory, directory, false]);
    }
    assert.equal(process.env.PYTHONHOME, undefined);
    assert.equal(process.env.PYTHONPATH, undefined);
  } finally { restore(); restore(); }
  assert.deepEqual(keys.map(key => process.env[key]), before);
});

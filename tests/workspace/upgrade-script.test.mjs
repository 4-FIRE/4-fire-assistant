import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { begin } from "../../dist/storage/workspace-state.js";

const exec = promisify(execFile);

async function snapshot(root) {
  const files = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    files[entry.name] = entry.isDirectory() ? await snapshot(path) : await readFile(path);
  }
  return files;
}

for (const kind of ["empty", "baseline", "unsupported"]) {
  test("standalone baseline script leaves the " + kind + " workspace unchanged", async t => {
    const temp = await mkdtemp(join(tmpdir(), "ffa-upgrade-script-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const root = join(temp, "workspace"), script = join(temp, "upgrade-0.3.0.mjs");
    await mkdir(root);
    await copyFile(new URL("../../scripts/upgrade-0.3.0.mjs", import.meta.url), script);
    if (kind === "baseline") await begin(root);
    if (kind === "unsupported") {
      await mkdir(join(root, ".ffa"));
      await writeFile(join(root, ".ffa/workspace.json"), JSON.stringify({ format: "ffa-pi/1", status: "ready" }));
      await writeFile(join(root, ".ffa/records.bin"), Buffer.from([0, 255, 17, 42]));
    }
    if (kind !== "empty") await writeFile(join(root, "AGENTS.md"), "User-owned work");
    const before = await snapshot(root);
    // The copied script has no package, Pi installation, dependencies or commands on PATH.
    await exec(process.execPath, [script], { cwd: root, env: { PATH: "" }, timeout: 5_000 });
    await exec(process.execPath, [script], { cwd: root, env: { PATH: "" }, timeout: 5_000 });
    assert.deepEqual(await snapshot(root), before);
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { saveWorkspace } from "../dist/infrastructure/workspace.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { DurableRuntime } from "../dist/infrastructure/durable-runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { terminalRun } from "./helpers/terminal-run.mjs";

const exec = promisify(execFile);

test("--list-sessions returns stored IDs and titles without model configuration or changing the active session", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-list-sessions-")), directory = join(root, ".ffa");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory);
  await saveWorkspace(directory, emptyWorkspace());
  const models = createModels(); models.setProvider(openaiProvider());
  const options = { directory, models, model: { provider: "openai", modelId: "gpt-4.1" } };
  const args = [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--list-sessions"];
  const runOptions = { cwd: root, timeout: 10000,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") } };
  assert.deepEqual(JSON.parse((await exec(process.execPath, args, runOptions)).stdout), []);
  let runtime = await DurableRuntime.open(options);
  let expected, active;
  try {
    await runtime.newSession("长期研究");
    await runtime.newSession();
    expected = await runtime.sessions();
    active = (await runtime.status()).conversation;
  } finally { await runtime.close(); }
  const listed = JSON.parse((await exec(process.execPath, args, runOptions)).stdout);
  assert.deepEqual(listed, expected);
  for (const item of listed) {
    assert.match(item.id, /^[0-9a-f-]{36}$/);
    assert.equal(new Date(item.createdAt).toISOString(), item.createdAt);
    assert.equal(new Date(item.updatedAt).toISOString(), item.updatedAt);
  }
  await assert.rejects(exec(process.execPath, [...args, "-p", "research"], runOptions), { code: 1 });
  runtime = await DurableRuntime.open(options);
  try {
    assert.deepEqual((await runtime.status()).conversation, active);
    assert.deepEqual(await runtime.sessions(), expected);
  } finally { await runtime.close(); }
});

for (const [name, input] of [["/quit", "/quit\r"], ["Ctrl+D", "\x04"]]) {
  test(`${name} exits the real CLI after cleanup despite a retained I/O handle`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "ffa-terminal-exit-")), directory = join(root, ".ffa");
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(directory);
    await saveWorkspace(directory, emptyWorkspace());
    // A real OS watcher keeps Node alive unless the executable finishes explicitly.
    // No model, service or terminal implementation is replaced.
    const preload = join(root, "watch.mjs");
    await writeFile(preload, 'import { watch } from "node:fs"; watch(process.cwd(), () => {});\n');
    const { stdout } = await exec("python3", ["-c", terminalRun, Buffer.from(input).toString("hex"),
      process.execPath, "--import", preload, fileURLToPath(new URL("../dist/main.js", import.meta.url)),
      "--model", "openai/gpt-4.1", "--auth-file", join(root, "auth.json"), "--models-file", join(root, "models.json")], {
      cwd: root, timeout: 12000,
      env: { PATH: process.env.PATH, HOME: root, TERM: "xterm-256color", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") },
    });
    assert.deepEqual(JSON.parse(stdout), { sent: true, code: 0, restored: true });
    const storage = await openApplicationStorage(directory);
    await storage.close();
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { DurableRuntime, WorkspaceDoc } from "../dist/infrastructure/durable-runtime.js";
import { WorkDoc } from "../dist/infrastructure/runtime-documents.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { saveWorkspace } from "../dist/infrastructure/workspace.js";
import { terminalRun } from "./helpers/terminal-run.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const models = createModels(); models.setProvider(openaiProvider());
const model = { provider: "openai", modelId: "gpt-4.1" };

async function fixture(t, pending = false) {
  const root = await mkdtemp(join(tmpdir(), "ffa-session-cli-")), directory = join(root, ".ffa");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory);
  await saveWorkspace(directory, emptyWorkspace());
  const options = { directory, models, model };
  const runtime = await DurableRuntime.open(options);
  let first, second;
  try {
    first = (await runtime.status()).conversation;
    second = await runtime.newSession("second");
  } finally { await runtime.close(); }
  const request = { requestId: "original-request", content: "original objective", status: "admitting", submissionId: null };
  const storage = await openApplicationStorage(directory);
  const harness = await Harness.open(storage.storage, { models, registry: createRegistry() }, context);
  try {
    await harness.commit(async tx => {
      const workspace = await tx.doc(WorkspaceDoc);
      if (pending) (await tx.doc(WorkDoc, workspace.sessions[0].id)).request = request;
    }, context);
  } finally { await harness.close(context); await storage.close(); }
  const configDirectory = join(root, "config", "4-fire-assistant");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "config.local.json"), JSON.stringify({ version: 1, model,
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), runtime: { generationRetries: 0 } }));
  // The real provider fails without credentials. No request can use personal credentials.
  const runOptions = { cwd: root, timeout: 12000, env: { PATH: process.env.PATH, HOME: root,
    TERM: "xterm-256color", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") } };
  return { root, directory, options, first, second, request, runOptions };
}
async function terminal(args, keys, runOptions) {
  const { stdout, stderr } = await exec("python3", ["-c", terminalRun,
    keys.map(key => Buffer.from(key).toString("hex")).join(","), process.execPath, cli, ...args], runOptions);
  assert.deepEqual(JSON.parse(stdout), { sent: true, code: 0, restored: true }, stderr);
}

for (const [name, args, keys, expected] of [
  ["default", [], ["/quit\r"], "new"],
  ["explicit first session", ["--session", "first"], ["/quit\r"], "first"],
  ["resume picker", ["-r"], ["\r", "/quit\r"], "first"],
  ["resume picker cancelled", ["-r"], ["\x1b"], "second"],
  ["explicit second session", ["--session", "second"], ["/quit\r"], "second"],
]) {
  test(`real CLI ${name} selects the session without scheduling work`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    await terminal(args[0] === "--session" ? ["--session", f[args[1]].id] : args, keys, f.runOptions);
    const runtime = await DurableRuntime.open(f.options);
    try {
      const status = await runtime.status();
      if (expected === "new") {
        assert.notEqual(status.conversation.id, f.first.id);
        assert.notEqual(status.conversation.id, f.second.id);
        assert.equal((await runtime.sessions()).length, 3);
      } else {
        assert.equal(status.conversation.id, f[expected].id);
        assert.equal((await runtime.sessions()).length, 2);
      }
      assert.equal(status.work, null);
      assert.equal(status.unfinishedTasks, 0);
    } finally { await runtime.close(); }
  });
}

test("positional prompts remain interactive; print exits and a selected session accepts a new prompt", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await terminal(["--session", f.first.id, "first", "objective"], ["/quit\r"], f.runOptions);
  let runtime = await DurableRuntime.open(f.options);
  try {
    assert.equal((await runtime.status()).conversation.id, f.first.id);
    assert.equal((await runtime.status()).work.content, "first objective");
    assert.equal((await runtime.status()).work.status, "unanswered");
  } finally { await runtime.close(); }
  await assert.rejects(exec(process.execPath, [cli, "--session", f.first.id, "-p", "second objective"], f.runOptions), { code: 1 });
  runtime = await DurableRuntime.open(f.options);
  try {
    assert.equal((await runtime.status()).conversation.id, f.first.id);
    assert.equal((await runtime.status()).work.content, "second objective");
    assert.equal((await runtime.status()).work.status, "unanswered");
    assert.equal((await runtime.sessions()).length, 2);
  } finally { await runtime.close(); }
  await assert.rejects(exec(process.execPath, [cli, "-p", "--", "-new objective"], f.runOptions), { code: 1 });
  runtime = await DurableRuntime.open(f.options);
  try {
    assert.notEqual((await runtime.status()).conversation.id, f.first.id);
    assert.equal((await runtime.status()).work.content, "-new objective");
    assert.equal((await runtime.sessions()).length, 3);
  } finally { await runtime.close(); }
});

for (const [name, choice, status] of [["leave", "\r", "admitting"],
  ["cancel", "\x1b[B\x1b[B\r", "cancelled"], ["restore", "\x1b[B\r", "unanswered"]]) {
  test(`interactive recovery ${name} preserves the original request identity`, { timeout: 15000 }, async t => {
    const f = await fixture(t, true);
    await terminal(["--session", f.first.id], [choice, "/quit\r"], f.runOptions);
    const runtime = await DurableRuntime.open(f.options);
    try {
      const current = await runtime.status();
      assert.equal(current.conversation.id, f.first.id);
      assert.equal(current.work.requestId, f.request.requestId);
      assert.equal(current.work.content, f.request.content);
      assert.equal(current.work.status, status);
      assert.equal(current.needsContinuation, name === "leave");
    } finally { await runtime.close(); }
  });
}

test("print exits from a real TTY after the request fails, without waiting for another line", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const { stdout } = await exec("python3", ["-c", terminalRun, Buffer.from("/quit\r").toString("hex"),
    process.execPath, cli, "--session", f.first.id, "-p", "objective"], f.runOptions);
  const result = JSON.parse(stdout);
  assert.equal(result.code, 1);
  assert.equal(result.restored, true);
  const runtime = await DurableRuntime.open(f.options);
  try {
    assert.equal((await runtime.status()).conversation.id, f.first.id);
    assert.equal((await runtime.status()).work.content, "objective");
    assert.equal((await runtime.status()).work.status, "unanswered");
  } finally { await runtime.close(); }
});

test("noninteractive session selection rejects pending work without replacing or admitting a request", async t => {
  const f = await fixture(t, true);
  for (const args of [["--session", f.first.id, "new objective"], ["--session", f.first.id, "-p"], ["--session", f.first.id, "-p", "new objective"]]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], f.runOptions),
      error => error.code === 1 && error.stderr.includes("RECOVERY_NEEDS_TTY"));
    const runtime = await DurableRuntime.open(f.options);
    try {
      const current = await runtime.status();
      assert.equal(current.conversation.id, f.first.id);
      assert.equal(current.work.requestId, f.request.requestId);
      assert.equal(current.work.content, f.request.content);
      assert.equal(current.work.status, "admitting");
      assert.equal(current.unfinishedTasks, 0);
      assert.equal((await runtime.sessions()).length, 2);
    } finally { await runtime.close(); }
  }
});

test("conflicting session options and removed options fail before opening a workspace", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-cli-options-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [["-c"], ["--continue"], ["-r", "--session", "missing"],
    ["--prompt", "objective"], ["--list-sessions", "-p"], ["--configure", "objective"]]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], { cwd: root, timeout: 10000 }),
      error => error.code === 1 && error.stderr.includes("INVALID_ARGUMENTS"));
  }
  await assert.rejects(exec(process.execPath, [cli, "-r"], { cwd: root, timeout: 10000 }),
    error => error.code === 1 && error.stderr.includes("RESUME_NEEDS_TTY"));
});

test("startup rejects unknown IDs and model changes without switching the active session", async t => {
  const f = await fixture(t, true);
  await assert.rejects(DurableRuntime.open({ ...f.options, session: { id: "missing" } }), { code: "SESSION_UNAVAILABLE" });
  await assert.rejects(DurableRuntime.open({ ...f.options, model: { provider: "openai", modelId: "gpt-4.1-mini" },
    session: { id: f.first.id } }), { code: "PENDING_MODEL_CHANGE" });
  const runtime = await DurableRuntime.open(f.options);
  try {
    assert.equal((await runtime.status()).conversation.id, f.second.id);
    assert.equal((await runtime.sessions()).length, 2);
    await runtime.selectSession(f.first.id);
    assert.equal((await runtime.status()).work.requestId, f.request.requestId);
  } finally { await runtime.close(); }
});

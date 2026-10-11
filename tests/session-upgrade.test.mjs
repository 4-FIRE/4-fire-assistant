import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { DurableRuntime } from "../dist/infrastructure/durable-runtime.js";
import { WorkDoc, IntentIndexDoc, IntentDoc } from "../dist/infrastructure/runtime-documents.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { saveWorkspace } from "../dist/infrastructure/workspace.js";

const exec = promisify(execFile);
const model = { provider: "openai", modelId: "gpt-4.1" };
const models = createModels(); models.setProvider(openaiProvider());
const indexAddress = { kind: "fire.workspace", scope: { kind: "session" } };
async function index(storage) {
  const record = await storage.storage.findDocument(indexAddress, "current", context);
  return storage.storage.document(record.id, "current", context);
}
async function fixture(t, version = 1, missing = false) {
  const root = await mkdtemp(join(tmpdir(), "ffa-session-upgrade-")), directory = join(root, ".ffa");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory);
  await saveWorkspace(directory, emptyWorkspace());
  const storage = await openApplicationStorage(directory);
  const harness = await Harness.open(storage.storage, { models, registry: createRegistry() }, context);
  const legacy = defineDoc({ kind: "fire.workspace", version, scope: "session",
    initial: () => ({ activeId: null, sessions: [] }) });
  const rootConversation = await harness.root(context, { agent: { model } });
  const request = { requestId: "pending", status: "admitting", content: "research", submissionId: null };
  let legacyValue;
  try {
    await harness.commit(async tx => {
      const other = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const workspace = await tx.doc(legacy);
      workspace.activeId = rootConversation.id;
      workspace.sessions = [{ id: rootConversation.id, title: "主会话" },
        { id: missing ? 999999 : other.id, title: "长期研究" }];
      (await tx.doc(WorkDoc, rootConversation.id)).request = request;
      (await tx.doc(IntentIndexDoc)).ids = ["unsettled"];
      (await tx.doc(IntentDoc, "unsettled", { state: "unknown" })).value = { state: "unknown" };
    }, context);
    legacyValue = structuredClone(await harness.snapshot(legacy, context));
  } finally { await harness.close(context); await storage.close(); }
  return { root, directory, legacyValue, request, rootId: rootConversation.id };
}

test("the real CLI upgrades only the legacy index and persists stable UUIDs", async t => {
  const { root, directory, legacyValue, request, rootId } = await fixture(t);
  const args = [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--list-sessions"];
  const options = { cwd: root, timeout: 10000,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") } };
  const listed = JSON.parse((await exec(process.execPath, args, options)).stdout);
  assert.deepEqual(listed.map(item => item.title), legacyValue.sessions.map(item => item.title));
  assert.equal(new Set(listed.map(item => item.id)).size, 2);
  for (const item of listed) {
    assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(item.createdAt, null);
    assert.equal(item.updatedAt, null);
  }
  assert.deepEqual(JSON.parse((await exec(process.execPath, args, options)).stdout), listed);
  const storage = await openApplicationStorage(directory);
  const upgraded = await index(storage);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.value.activeId, rootId);
  assert.deepEqual(upgraded.value.sessions.map(({ id, title }) => ({ id, title })), legacyValue.sessions);
  await storage.close();
  const runtime = await DurableRuntime.open({ directory, models, model });
  try {
    assert.equal((await runtime.status()).conversation.id, listed[0].id);
    assert.equal((await runtime.status()).needsContinuation, true);
    assert.deepEqual(await runtime.sessions(), listed);
  } finally { await runtime.close(); }
  const inspectionStorage = await openApplicationStorage(directory);
  const inspection = await Harness.open(inspectionStorage.storage, { models, registry: createRegistry() }, context);
  try {
    assert.deepEqual((await inspection.snapshot(WorkDoc, rootId, context)).request, request);
    assert.deepEqual((await inspection.snapshot(IntentIndexDoc, context)).ids, ["unsettled"]);
    assert.deepEqual((await inspection.snapshot(IntentDoc, "unsettled", context)).value, { state: "unknown" });
    assert.equal((await inspection.inspect(context)).scheduling, "paused");
  } finally { await inspection.close(context); await inspectionStorage.close(); }
});

test("--upgrade-workspace upgrades without a model, preserves files and is idempotent", async t => {
  const { root, directory, rootId, request } = await fixture(t);
  const documents = ["AGENTS.md", "SOUL.md"];
  for (const name of documents) await writeFile(join(root, name), `local ${name}\n`);
  const config = await readFile(join(directory, "config.json"), "utf8");
  const beforeFiles = await readdir(root);
  const args = [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--upgrade-workspace"];
  const options = { cwd: root, timeout: 10000,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") } };
  for (const conflict of [[""], ["--print"], ["--continue"], ["--resume"], ["--session", "missing"], ["--list-sessions"], ["--configure"],
    ["--list-models"], ["--setup-compute"], ["--compute-status"], ["--data-dir", root]]) {
    await assert.rejects(exec(process.execPath, [...args, ...conflict], options), { code: 1 });
  }
  let storage = await openApplicationStorage(directory);
  try { assert.equal((await index(storage)).version, 1); }
  finally { await storage.close(); }
  assert.deepEqual(JSON.parse((await exec(process.execPath, args, options)).stdout), { upgraded: true });
  storage = await openApplicationStorage(directory);
  let after;
  try { after = await index(storage); assert.equal(after.version, 2); }
  finally { await storage.close(); }
  assert.deepEqual(JSON.parse((await exec(process.execPath, args, options)).stdout), { upgraded: false });
  storage = await openApplicationStorage(directory);
  const inspection = await Harness.open(storage.storage, { models, registry: createRegistry() }, context);
  try {
    assert.deepEqual(await index(storage), after);
    assert.deepEqual((await inspection.snapshot(WorkDoc, rootId, context)).request, request);
    assert.deepEqual((await inspection.snapshot(IntentDoc, "unsettled", context)).value, { state: "unknown" });
    assert.equal((await inspection.inspect(context)).scheduling, "paused");
  } finally { await inspection.close(context); await storage.close(); }
  assert.deepEqual(await readdir(root), beforeFiles);
  assert.equal(await readFile(join(directory, "config.json"), "utf8"), config);
  for (const name of documents) assert.equal(await readFile(join(root, name), "utf8"), `local ${name}\n`);
});

test("--upgrade-workspace does not create a missing workspace", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-upgrade-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--upgrade-workspace"],
    { cwd: root, timeout: 10000 }), { code: 1 });
  assert.deepEqual(await readdir(root), []);
});

test("normal startup upgrades the index without requiring a prior list command", async t => {
  const { directory } = await fixture(t);
  const runtime = await DurableRuntime.open({ directory, models, model });
  try {
    assert.match((await runtime.status()).conversation.id, /^[0-9a-f-]{36}$/);
    assert.equal((await runtime.status()).needsContinuation, true);
  } finally { await runtime.close(); }
  const storage = await openApplicationStorage(directory);
  try { assert.equal((await index(storage)).version, 2); }
  finally { await storage.close(); }
});

for (const [version, missing, code] of [[1, true, "SESSION_INDEX_INVALID"], [3, false, "SESSION_INDEX_VERSION"]]) {
  test(`index version ${version} with missing=${missing} fails without changing stored values`, async t => {
    const { directory, legacyValue } = await fixture(t, version, missing);
    const storage = await openApplicationStorage(directory);
    try { await assert.rejects(DurableRuntime.listSessions(storage), { code }); }
    finally { await storage.close(); }
    const reopened = await openApplicationStorage(directory);
    try {
      const stored = await index(reopened);
      assert.equal(stored.version, version);
      assert.deepEqual(stored.value, legacyValue);
    } finally { await reopened.close(); }
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolCall } from "@earendil-works/pi-ai";
import { setupTools } from "../dist/infrastructure/setup-tools.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { emptyWorkspace } from "../dist/domain/workspace.js";
import { saveWorkspace } from "../dist/infrastructure/workspace.js";
import { ResourceSnapshot, seedWorkspaceDocuments } from "../dist/infrastructure/resources.js";
import { WorkspaceServices } from "../dist/infrastructure/workspace-services.js";
import { DurableRuntime, WorkspaceDoc } from "../dist/infrastructure/durable-runtime.js";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalApproval } from "../dist/interfaces/approval.js";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { WorkDoc, TeamDoc } from "../dist/infrastructure/runtime-documents.js";
import { BusinessIntegration } from "../dist/infrastructure/assistant-integration.js";
async function internalId(harness, uuid) {
  const workspace = await harness.snapshot(WorkspaceDoc, context);
  const session = workspace.sessions.find(item => item.uuid === uuid);
  assert.ok(session);
  return session.id;
}

test("assembled tools retain role permissions and write replay policy", async () => {
  const integration = await BusinessIntegration.create({}, { provider: "openai", modelId: "gpt-4.1" });
  const tools = integration.extension.tools;
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
  const executionNames = ["prepare_write", "submit_review", "execute_write", "read_intent"];
  assert.deepEqual(executionNames.map(name => tools.find(tool => tool.name === name)?.replay),
    ["safe", "safe", "unsafe", "safe"]);
  for (const [role, expected] of [
    ["coordinator", ["prepare_write", "execute_write", "read_intent"]],
    ["reviewer", ["submit_review", "read_intent"]],
    ["researcher", ["read_intent"]],
  ]) {
    const removed = new Set(integration.agent(role).tools.remove.map(tool => tool.name));
    assert.deepEqual(executionNames.filter(name => !removed.has(name)), expected);
    assert.equal(removed.has("delegate_expert"), role !== "coordinator");
  }
});

// Admit real SDK work while scheduling is paused, as it can be after a crash.
const { admitSubmission } = await import(new URL("./harness/submissions.js", import.meta.resolve("@earendil-works/pi-durable")));

test("recovery associates expert submissions with their owner and request; cancel clears placed remnants", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "ffa-recovery-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = createModels(); models.setProvider(openaiProvider());
  const model = { provider: "openai", modelId: "gpt-4.1" };
  const options = { directory, models, model, business: {} };
  let runtime = await DurableRuntime.open(options);
  t.after(() => runtime.close());
  const first = (await runtime.status()).conversation;
  const owner = await runtime.newSession();
  await runtime.selectSession(first.id);
  await runtime.close();

  const storage = await openApplicationStorage(directory);
  const integration = await BusinessIntegration.create({}, model);
  const registry = createRegistry(); registry.install(integration.extension);
  const harness = await Harness.open(storage.storage, { models, registry }, context);
  let submissionId;
  try {
    const childId = await harness.commit(async tx => {
      const ownerId = (await tx.doc(WorkspaceDoc)).sessions.find(item => item.uuid === owner.id).id;
      const anchor = await tx.createTask(integration.extension.tasks[0], null,
        { conversationId: ownerId, ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
      const team = await tx.doc(TeamDoc, ownerId);
      team.experts.push({ expertId: "expert", role: "researcher", conversationId: child.id, purpose: "research", reportRefs: [], active: "delegate" });
      team.delegations.push({ key: "delegate", expertId: "expert", conversationId: child.id, ownerId, ownerRequestId: "owner-request",
        role: "researcher", goal: "research", requestId: "delegate", roundId: "delegate", submissionId: null, reportRef: null });
      (await tx.doc(WorkDoc, ownerId)).request = { requestId: "owner-request", status: "admitting", content: "research", submissionId: null };
      return child.id;
    }, context);
    submissionId = await harness.commit(tx => admitSubmission(tx, childId,
      { type: "input", content: "research", requestId: "delegate" }, Date.now(), { steer: "all", followUp: "all" }), context);
    assert.equal((await harness.inspect(context)).scheduling, "paused");
    assert.equal(await harness.abortSubmission(submissionId, context), "already_placed");
  } finally { await harness.close(context); await storage.close(); }

  runtime = await DurableRuntime.open({ ...options, session: "new" });
  assert.deepEqual((await runtime.status()).blocked, []);
  assert.equal((await runtime.status()).work, null);
  assert.equal((await runtime.status()).otherPendingSessions[0].conversation.id, owner.id);
  assert.equal((await runtime.status()).otherPendingSessions[0].work.requestId, "owner-request");
  await assert.rejects(runtime.submit("new objective"), { code: "OTHER_SESSION_PENDING" });
  await assert.rejects(runtime.cancel(), { code: "OTHER_SESSION_PENDING" });
  await runtime.selectSession(owner.id);
  const pending = await runtime.status();
  assert.equal(pending.needsContinuation, true);
  assert.deepEqual(pending.blocked, []);
  await runtime.close();

  // The request was cancelled durably, but its SDK abort had not run yet.
  const reopenedStorage = await openApplicationStorage(directory);
  const reopened = await Harness.open(reopenedStorage.storage, { models, registry }, context);
  try {
    const ownerId = await internalId(reopened, owner.id);
    await reopened.commit(async tx => { (await tx.doc(WorkDoc, ownerId)).request.status = "cancelled"; }, context);
  } finally { await reopened.close(context); await reopenedStorage.close(); }
  runtime = await DurableRuntime.open(options);
  assert.deepEqual((await runtime.status()).blocked, ["work_association_missing"]);
  await assert.rejects(runtime.newSession(), { code: "RECOVERY_BLOCKED" });
  await assert.rejects(runtime.continueWork(), { code: "RECOVERY_BLOCKED" });
  await runtime.cancel();
  assert.deepEqual((await runtime.status()).blocked, []);
  assert.equal((await runtime.status()).unfinishedTasks, 0);
  await runtime.newSession();
});

test("session selection preserves pending model bindings and leaves the active session unchanged on rejection", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ffa-pending-model-"));
  const models = createModels(); models.setProvider(openaiProvider());
  const model = { provider: "openai", modelId: "gpt-4.1" };
  const changed = { provider: "openai", modelId: "gpt-4.1-mini" };
  const options = { directory, models, model };
  let runtime;
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  runtime = await DurableRuntime.open(options);
  const idle = (await runtime.status()).conversation;
  const pending = await runtime.newSession();
  await runtime.selectSession(idle.id);
  await runtime.close();

  const storage = await openApplicationStorage(directory);
  const harness = await Harness.open(storage.storage, { models, registry: createRegistry() }, context);
  const request = { requestId: "pending-model", status: "admitting", content: "unfinished work", submissionId: null };
  try {
    const pendingId = await internalId(harness, pending.id);
    await harness.commit(async tx => { (await tx.doc(WorkDoc, pendingId)).request = request; }, context);
  } finally { await harness.close(context); await storage.close(); }

  runtime = await DurableRuntime.open({ ...options, model: changed });
  await assert.rejects(runtime.selectSession(pending.id), { code: "PENDING_MODEL_CHANGE" });
  assert.equal((await runtime.status()).conversation.id, idle.id);
  await runtime.close();
  runtime = await DurableRuntime.open({ ...options, model: changed });
  assert.equal((await runtime.status()).conversation.id, idle.id);
  await runtime.close();

  const inspectionStorage = await openApplicationStorage(directory);
  const inspection = await Harness.open(inspectionStorage.storage, { models, registry: createRegistry() }, context);
  try {
    const pendingId = await internalId(inspection, pending.id), idleId = await internalId(inspection, idle.id);
    assert.deepEqual((await (await inspection.conversation(pendingId, context)).agent(context)).model, model);
    assert.deepEqual((await inspection.snapshot(WorkDoc, pendingId, context)).request, request);
    assert.deepEqual((await (await inspection.conversation(idleId, context)).agent(context)).model, changed);
    assert.equal((await inspection.inspect(context)).scheduling, "paused");
  } finally { await inspection.close(context); await inspectionStorage.close(); }

  runtime = await DurableRuntime.open(options);
  await runtime.selectSession(pending.id);
  assert.equal((await runtime.status()).needsContinuation, true);
  await runtime.close();
  await assert.rejects(DurableRuntime.open({ ...options, model: changed }), { code: "PENDING_MODEL_CHANGE" });
  runtime = await DurableRuntime.open(options);
  assert.equal((await runtime.status()).work.requestId, request.requestId);
});

test("session UUIDs and timestamps persist; only work changes update the timestamp", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ffa-session-metadata-"));
  const models = createModels(); models.setProvider(openaiProvider());
  const options = { directory, models, model: { provider: "openai", modelId: "gpt-4.1" } };
  let runtime = await DurableRuntime.open(options);
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const first = (await runtime.status()).conversation;
  await delay(5);
  const second = await runtime.newSession("研究");
  const before = await runtime.sessions();
  assert.equal(new Set(before.map(item => item.id)).size, 2);
  for (const session of before) {
    assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Date(session.createdAt).toISOString(), session.createdAt);
    assert.equal(session.createdAt, session.updatedAt);
  }
  await runtime.selectSession(first.id);
  await runtime.selectSession(second.id);
  await runtime.cancel(); // No pending request: leave the timestamp unchanged.
  assert.deepEqual(await runtime.sessions(), before);
  await runtime.close();

  const storage = await openApplicationStorage(directory);
  const harness = await Harness.open(storage.storage, { models, registry: createRegistry() }, context);
  try {
    const id = await internalId(harness, second.id);
    await harness.commit(async tx => {
      (await tx.doc(WorkDoc, id)).request = {
        requestId: "pending", status: "admitting", content: "research", submissionId: null,
      };
    }, context);
  } finally { await harness.close(context); await storage.close(); }
  runtime = await DurableRuntime.open(options);
  await delay(5);
  await runtime.cancel();
  const after = await runtime.sessions();
  assert.deepEqual(after[0], before[0]);
  assert.equal(after[1].id, second.id);
  assert.equal(after[1].createdAt, before[1].createdAt);
  assert.ok(after[1].updatedAt > before[1].updatedAt);
  await runtime.close();
  runtime = await DurableRuntime.open(options);
  assert.deepEqual(await runtime.sessions(), after);
  assert.deepEqual((await runtime.status()).conversation, second);
});

test("real durable runtime opens and reopens the unified assistant without scheduling model work", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-startup-")), directory = join(root, ".ffa");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory);
  await saveWorkspace(directory, emptyWorkspace());
  await seedWorkspaceDocuments(root);
  const models = createModels();
  models.setProvider(openaiProvider());
  const approval = new TerminalApproval(message => process.stdout.write(message + "\n"));
  const confirmAction = approval.confirmAction.bind(approval);
  const services = await WorkspaceServices.open(directory, confirmAction);
  t.after(() => services.close());
  const setup = setupTools(services, confirmAction);
  const argumentsForSource = { id: "options_trade", connection: { transport: "http", url: "https://example.invalid/mcp" },
    operations: [{ name: "query", access: "read", roles: ["coordinator"] }] };
  assert.throws(() => validateToolCall(setup, { type: "toolCall", id: "validate-source", name: "configure_source", arguments: argumentsForSource }));
  assert.equal(validateToolCall(setup, { type: "toolCall", id: "validate-source", name: "configure_source",
    arguments: { ...argumentsForSource, id: "options-trade" } }).id, "options-trade");
  const business = { services, trading: services, approval, confirmAction, workingDirectory: root, resources: await ResourceSnapshot.load(root) };
  let runtime = await DurableRuntime.open({ directory, models, model: { provider: "openai", modelId: "gpt-4.1" }, business });
  t.after(() => runtime.close());
  const before = await runtime.status();
  assert.equal(before.work, null);
  assert.equal(before.unfinishedTasks, 0);
  assert.equal(before.needsContinuation, false);
  assert.equal(services.initialized, false);
  assert.throws(() => services.requireInitialized(), { code: "INITIALIZATION_REQUIRED" });
  await assert.rejects(services.finish("market", undefined, undefined), { code: "INITIALIZATION_EVIDENCE_REQUIRED" });
  assert.deepEqual(await runtime.experts(), []);
  assert.deepEqual(await runtime.intents(), []);
  await runtime.close();
  runtime = await DurableRuntime.open({ directory, models, model: { provider: "openai", modelId: "gpt-4.1" }, business });
  const after = await runtime.status();
  assert.equal(after.conversation.id, before.conversation.id);
  assert.equal(after.unfinishedTasks, 0);
  assert.equal(after.work, null);

  // A request may be durable before its SDK submission is admitted.
  await runtime.close();
  const storage = await openApplicationStorage(directory);
  const harness = await Harness.open(storage.storage, { models, registry: createRegistry() }, context);
  const owner = await harness.root(context);
  assert.equal((await owner.agent(context)).cwd, root);
  const pending = { requestId: "unadmitted-request", content: "research objective", status: "admitting", submissionId: null };
  await harness.commit(async tx => { (await tx.doc(WorkDoc, owner.id)).request = pending; }, context);
  await harness.close(context); await storage.close();
  runtime = await DurableRuntime.open({ directory, models, model: { provider: "openai", modelId: "gpt-4.1" }, business });
  const resumed = await runtime.status();
  assert.equal(resumed.needsContinuation, true);
  assert.equal(resumed.work.requestId, pending.requestId);
  assert.equal(resumed.unfinishedTasks, 0);
  await assert.rejects(runtime.newSession(), { code: "WORK_BUSY" });
  await runtime.cancel();
  assert.equal((await runtime.status()).work.status, "cancelled");
  const other = await runtime.newSession();
  assert.notEqual(other.id, resumed.conversation.id);
  await runtime.selectSession(resumed.conversation.id);
  assert.equal((await runtime.status()).work.requestId, pending.requestId);
  assert.equal((await runtime.status()).needsContinuation, false);
});


test("new requests reload local roles before admission and leave no work when loading fails", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-role-refresh-")), directory = join(root, ".ffa");
  await mkdir(join(root, "roles"));
  const role = join(root, "roles", "coordinator.md");
  await writeFile(role, "Local role input");
  const models = createModels(); models.setProvider(openaiProvider());
  const model = { provider: "openai", modelId: "gpt-4.1" };
  const runtime = await DurableRuntime.open({ directory, models, model, business: { workingDirectory: root } });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await rm(role); await mkdir(role);
  await assert.rejects(runtime.submit("Read existing work"), { code: "EISDIR" });
  const status = await runtime.status();
  assert.equal(status.work, null);
  assert.equal(status.unfinishedTasks, 0);
  const integration = await BusinessIntegration.create({ workingDirectory: root, resources: ResourceSnapshot.defaults() }, model);
  const tools = integration.extension.tools.map(tool => tool.name);
  assert.equal(tools.includes("memory_recall"), true);
  assert.equal(tools.includes("memory_read"), false);
  assert.equal(tools.includes("memory_save"), false);
});

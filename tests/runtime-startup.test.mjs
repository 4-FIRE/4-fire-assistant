import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
import { DurableRuntime } from "../dist/infrastructure/durable.js";
import { TerminalApproval } from "../dist/interfaces/approval.js";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { WorkDoc, TeamDoc } from "../dist/infrastructure/business-documents.js";
import { BusinessIntegration } from "../dist/infrastructure/business.js";
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
      const ownerId = Number(owner.id);
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

  runtime = await DurableRuntime.open(options);
  assert.deepEqual((await runtime.status()).blocked, []);
  await runtime.newSession();
  await runtime.selectSession(owner.id);
  const pending = await runtime.status();
  assert.equal(pending.needsContinuation, true);
  assert.deepEqual(pending.blocked, []);
  await runtime.close();

  // The request was cancelled durably, but its SDK abort had not run yet.
  const reopenedStorage = await openApplicationStorage(directory);
  const reopened = await Harness.open(reopenedStorage.storage, { models, registry }, context);
  try {
    await reopened.commit(async tx => { (await tx.doc(WorkDoc, Number(owner.id))).request.status = "cancelled"; }, context);
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

test("real durable runtime opens and reopens the unified assistant without scheduling model work", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-startup-")), directory = join(root, ".ffa");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory);
  await saveWorkspace(directory, emptyWorkspace());
  await seedWorkspaceDocuments(directory);
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
  const business = { services, trading: services, approval, confirmAction, resources: await ResourceSnapshot.load(directory) };
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

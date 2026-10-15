import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager, ModelRuntime, ModelRegistry, createAgentSession, SettingsManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentQueue } from "../../dist/services/agents/agent-queue.js";
import { runCommand } from "../../dist/integrations/process.js";
import { agentSession, agentTurn, openAgentSession, PiAgents } from "../../dist/integrations/pi/pi-agents.js";
import { agentLoader, agentDefinitions } from "../../dist/integrations/pi/agent-resources.js";
import { Confirmations } from "../../dist/ui/confirmation.js";
import { schema } from "../../dist/common/validation.js";
import { agentActionSchema } from "../../dist/tools/agents/contract.js";
import { host } from "../helpers/pi-host.mjs";

async function directory(t, cleanup) {
  const root = await mkdtemp(join(tmpdir(), "ffa-agent-engine-"));
  t.after(async () => { try { await cleanup?.(); } finally { await rm(root, { recursive: true, force: true }); } });
  return root;
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function fileAppears(path) {
  if (await exists(path)) return;
  await new Promise((resolve, reject) => {
    const watcher = watch(new URL(".", pathToFileURL(path)), async () => {
      if (await exists(path)) { clearTimeout(timer); watcher.close(); resolve(); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Local process did not write its marker")); }, 10000);
    void exists(path).then(found => { if (found) { clearTimeout(timer); watcher.close(); resolve(); } });
  });
}
const computation = "import sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text('started')\nwhile not Path(sys.argv[2]).exists(): time.sleep(.01)\nprint(42)";
function localWork(root, id) {
  return signal => runCommand("/usr/bin/python3", ["-c", computation, join(root, `start-${id}`), join(root, `release-${id}`)], undefined, root, {}, signal);
}

test("one five-slot queue holds excess real processes and cancels queued work without starting it", { timeout: 20000 }, async t => {
  const queue = new AgentQueue(), root = await directory(t, () => queue.close());
  const controllers = Array.from({ length: 7 }, () => new AbortController());
  const pending = controllers.map((controller, id) => queue.run(localWork(root, id), controller.signal));
  const seventh = assert.rejects(pending[6]);
  await Promise.all([0, 1, 2, 3, 4].map(id => fileAppears(join(root, `start-${id}`))));
  assert.equal(await exists(join(root, "start-5")), false);
  controllers[6].abort(); await seventh;
  await writeFile(join(root, "release-0"), "release");
  assert.equal((await pending[0]).data, 42);
  await fileAppears(join(root, "start-5"));
  assert.equal(await exists(join(root, "start-6")), false);
  await queue.close();
  await Promise.allSettled(pending);
  await assert.rejects(queue.run(localWork(root, 7), new AbortController().signal));
  assert.equal(await exists(join(root, "start-7")), false);
});

test("cancelling an active process releases its slot only after local cleanup finishes", { timeout: 15000 }, async t => {
  const queue = new AgentQueue(1), root = await directory(t, () => queue.close()), controller = new AbortController();
  const first = queue.run(async signal => {
    const result = await localWork(root, 0)(signal);
    await writeFile(join(root, "exited"), "saved");
    return result;
  }, controller.signal);
  const second = queue.run(async signal => {
    assert.equal(await readFile(join(root, "exited"), "utf8"), "saved");
    return runCommand("/usr/bin/printf", ["%s", "42"], undefined, root, {}, signal);
  }, new AbortController().signal);
  await fileAppears(join(root, "start-0")); controller.abort();
  await first;
  assert.equal((await second).data, 42);
  await queue.close(); await queue.close();
});

const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
// Serialized session values exercise history selection, not a fake model or provider.
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (text, stopReason = "stop") => ({ role: "assistant", api: "openai-codex-responses", provider: "openai-codex",
  model: "gpt-5.4", content: text ? [{ type: "text", text }] : [], stopReason, usage, timestamp: Date.now() });

test("native continuation forks from the recorded child leaf and does not include later sibling history", async t => {
  const root = await directory(t), sessions = join(root, "sessions"), manager = SessionManager.create(root, sessions);
  manager.appendMessage(user("first input"));
  const leaf = manager.appendMessage(assistant("first report"));
  const ref = { conversationId: "research", agent: "researcher", file: manager.getSessionFile(), leaf };
  manager.appendMessage(user("later input")); manager.appendMessage(assistant("later report"));
  const left = await agentSession(root, sessions, ref), right = await agentSession(root, sessions, ref);
  assert.notEqual(left.getSessionFile(), right.getSessionFile());
  assert.notEqual(left.getSessionFile(), ref.file);
  left.appendMessage(user("left input")); const leftLeaf = left.appendMessage(assistant("left report"));
  assert.equal(right.getEntry(leftLeaf), undefined);
  assert.equal(right.getBranch().at(-1).id, leaf);
  assert.equal(SessionManager.open(ref.file).getBranch().at(-1).message.content[0].text, "later report");
  assert.equal(SessionManager.open(left.getSessionFile()).getBranch().at(-1).id, leftLeaf);
  await assert.rejects(agentSession(root, sessions, { ...ref, leaf: "missing" }));
  const other = await directory(t);
  await assert.rejects(openAgentSession(other, sessions, ref));
  const outside = SessionManager.create(root, join(other, "sessions"));
  outside.appendMessage(user("outside"));
  await assert.rejects(openAgentSession(root, sessions, { ...ref, file: outside.getSessionFile(), leaf: outside.getLeafId() }));
});

test("a request without a new assistant cannot return the old report; partial failures and usage stay local to the request", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user("old")); const checkpoint = manager.appendMessage(assistant("old report"));
  assert.deepEqual(agentTurn(manager, checkpoint).report, "");
  assert.equal(agentTurn(manager, checkpoint).failed, true);
  assert.equal(agentTurn(manager, checkpoint).usage.totalTokens, 0);
  manager.appendMessage(user("new"));
  manager.appendMessage(assistant("partial report", "aborted"));
  manager.appendUsage("local-accounting", "openai-codex", "gpt-5.4", usage);
  const result = agentTurn(manager, checkpoint);
  assert.equal(result.report, "partial report"); assert.equal(result.failed, true);
  assert.equal(result.usage.totalTokens, 10);
  manager.appendMessage(assistant("", "error"));
  assert.equal(agentTurn(manager, checkpoint).report, "partial report");
  manager.appendMessage(assistant("", "stop"));
  assert.equal(agentTurn(manager, checkpoint).failed, true);
  assert.throws(() => agentTurn(manager, "missing"));
});

test("SDK agent failure without host authentication keeps a new empty report and disposes cleanly", async t => {
  const root = await directory(t), runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels("openai-codex")[0];
  const { session } = await createAgentSession({ cwd: root, model, modelRuntime: runtime,
    sessionManager: SessionManager.create(root, join(root, "sessions")), settingsManager: SettingsManager.inMemory(),
    resourceLoader: await agentLoader(root, "general-purpose"), tools: ["read"] });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "json" });
  const ctx = session.extensionRunner.createContext(), progress = [];
  await assert.rejects(new PiAgents().run(ctx, "general-purpose", "Local unauthenticated request", [],
    undefined, new AbortController().signal, value => progress.push(value), () => {}));
  assert.ok(progress.some(value => value.session));
  assert.ok(progress.every(value => !value.report));
  assert.equal(await runtime.checkAuth(model.provider), undefined);
  assert.equal(new ModelRegistry(runtime).hasConfiguredAuth(model), false);
});

test("agent definitions use agents only and reject an unavailable coordinator as a delegated role", async t => {
  const root = await directory(t);
  await mkdir(join(root, "agents")); await mkdir(join(root, "roles"));
  await writeFile(join(root, "agents/local-calc.md"), "Local calculation duty");
  await writeFile(join(root, "roles/obsolete.md"), "User-owned old material");
  assert.deepEqual(await agentDefinitions(root), ["general-purpose", "local-calc", "researcher", "reviewer"]);
  await assert.rejects(agentLoader(root, "coordinator"));
  await assert.rejects(agentLoader(root, "../local-calc"));
  assert.equal(await exists(join(root, "roles/obsolete.md")), true);
});

test("public agent tools preserve structured failures, result ownership and usage reporting without a model request", async t => {
  const { session } = await host(t, "ready");
  const agentTool = session.agent.state.tools.find(tool => tool.name === "ffa_agent");
  assert.deepEqual(session.getAllTools().filter(tool => /^ffa_(?:delegate|agents?)$/.test(tool.name)).map(tool => tool.name), ["ffa_agent"]);
  assert.equal(session.extensionRunner.getToolDefinition("ffa_agent").parameters.type, "object");
  const foreground = await agentTool.execute("foreground", { action: "start", agent: "general-purpose", message: "Local request without authentication" });
  assert.equal(foreground.structuredContent.state, "failed");
  assert.equal(foreground.isError, true); assert.equal(foreground.structuredContent.report, "");
  assert.equal("failed" in foreground.structuredContent, false);
  assert.ok(schema(session.extensionRunner.getToolDefinition("ffa_agent").outputSchema)(foreground.structuredContent));
  const queued = await agentTool.execute("background", { action: "start", agent: "researcher", message: "Local background request", mode: "background" });
  const runId = queued.structuredContent.runId;
  const completed = await agentTool.execute("wait", { action: "wait", runId });
  assert.equal(completed.structuredContent.state, "failed");
  const list = await agentTool.execute("list", { action: "list" });
  assert.ok(list.structuredContent.agents.includes("researcher"));
  assert.ok(list.structuredContent.runs.some(value => value.runId === runId));
  assert.ok(schema(session.extensionRunner.getToolDefinition("ffa_agent").outputSchema)(list.structuredContent));
  await assert.rejects(agentTool.execute("ended-steer", { action: "steer", runId, message: "More evidence" }));
  await assert.rejects(agentTool.execute("foreign-continue", { action: "continue", runId: "foreign", message: "Follow up" }));
  const again = await agentTool.execute("read", { action: "read", runId });
  assert.deepEqual(again.details.agentUsageRunIds, []);
  assert.equal(again.usage.totalTokens, 0);
  await assert.rejects(agentTool.execute("foreign", { action: "read", runId: "foreign" }));
  const initial = session.sessionManager.getBranch().find(entry => entry.type === "custom" && entry.customType === "ffa.agent-run");
  assert.equal((await session.navigateTree(initial.id, { summarize: false })).cancelled, false);
  const restored = await agentTool.execute("branch", { action: "read", runId: initial.data.runId });
  assert.equal(restored.structuredContent.state, "interrupted");
  assert.equal(restored.structuredContent.report, "");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  await assert.rejects(agentTool.execute("stale", { action: "read", runId }));
});

test("agent actions require exactly their own fields before any execution is created", async t => {
  const { session } = await host(t, "ready"), tool = session.agent.state.tools.find(tool => tool.name === "ffa_agent");
  const valid = schema(agentActionSchema);
  const inputs = [
    { action: "start", message: "Missing definition" },
    { action: "start", agent: "researcher", message: "Conflicting target", runId: "other" },
    { action: "continue", runId: "other", message: "Changed definition", agent: "reviewer" },
    { action: "steer", runId: "other" },
    { action: "steer", runId: "other", message: "Not a new execution", mode: "background" },
    { action: "list", runId: "other" },
    { action: "read" },
    { action: "stop", runId: "other", offset: 0 },
    { action: "unknown" },
  ];
  for (const input of inputs) {
    assert.equal(valid(input), false);
    await assert.rejects(tool.execute("invalid", input));
  }
  for (const input of [
    { action: "start", agent: "researcher", message: "New request", mode: "background" },
    { action: "continue", runId: "recorded", message: "Next request" },
    { action: "steer", runId: "recorded", message: "Additional evidence" },
    { action: "list" }, { action: "read", runId: "recorded", offset: 0, limit: 10 },
    { action: "wait", runId: "recorded" }, { action: "stop", runId: "recorded" },
  ]) assert.equal(valid(input), true);
  assert.deepEqual((await tool.execute("list", { action: "list" })).structuredContent.runs, []);
});

test("native steering acknowledges queued input without claiming a model read it", async t => {
  const root = await directory(t);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: root, modelRuntime: runtime,
    model: runtime.getModels("openai-codex")[0], settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(root), resourceLoader: await agentLoader(root, "researcher"), tools: ["read"] });
  t.after(() => session.dispose());
  assert.equal(await session.steer("Additional local evidence"), "queued");
  assert.deepEqual(session.getSteeringMessages(), ["Additional local evidence"]);
  assert.equal(session.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user"), false);
});

test("confirmation pause gates future requests and cancellation releases a paused wait", async () => {
  const confirmations = new Confirmations(), controller = new AbortController();
  confirmations.pause();
  let resumed = false;
  const pending = confirmations.ready(controller.signal).then(() => { resumed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resumed, false);
  confirmations.resume(); await pending; assert.equal(resumed, true);
  confirmations.pause();
  const aborted = assert.rejects(confirmations.ready(controller.signal));
  controller.abort(); await aborted;
  confirmations.resume(); await confirmations.ready();
});

function boundaryPreview(session, drafts) {
  const manager = SessionManager.inMemory(session.sessionManager.getCwd(), undefined,
    [session.sessionManager.getHeader(), ...structuredClone(session.sessionManager.getEntries())]);
  const before = manager.buildSessionProjection().messages.length;
  for (const draft of drafts) {
    if (draft.type === "custom_message") manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
    else if (draft.type === "custom") manager.appendCustomEntry(draft.customType, draft.data);
    else throw new Error("Unexpected local boundary draft");
  }
  const projection = manager.buildSessionProjection();
  return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: convertToLlm(projection.messages),
    pendingMessages: projection.messages.slice(before), canContinue: true };
}
async function completedWithoutClaim(agentTool, runId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await agentTool.execute("observe", { action: "list" });
    if (result.structuredContent.runs.find(value => value.runId === runId)?.finishedAt) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("Local unauthenticated agent did not settle");
}

test("SDK boundaries defer interrupted deliveries, merge completed results and do not redeliver a claimed report", async t => {
  const { session, errors } = await host(t, "ready");
  const agentTool = session.agent.state.tools.find(tool => tool.name === "ffa_agent");
  await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
  const runIds = [];
  for (let index = 0; index < 10; index++) {
    const output = await agentTool.execute("background-" + index, { action: "start", agent: "general-purpose", message: "No authenticated model request", mode: "background" });
    runIds.push(output.structuredContent.runId);
    await completedWithoutClaim(agentTool, runIds.at(-1));
  }
  const boundary = () => session.extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: "completed" },
    drafts => boundaryPreview(session, drafts));
  const paused = await boundary(); assert.equal(paused.continue, false); assert.deepEqual(paused.entries, []);
  await session.extensionRunner.emitInput("Continue original request", undefined, "interactive");
  const merged = await boundary();
  assert.equal(merged.valid, true); assert.equal(merged.continue, true); assert.equal(merged.entries.length, 1);
  assert.deepEqual(merged.entries[0].details.runIds, runIds.slice(0, 8));
  const remaining = await boundary();
  assert.equal(remaining.continue, true);
  assert.deepEqual(remaining.entries[0].details.runIds, runIds.slice(8));
  assert.equal((await boundary()).continue, false);
  const third = await agentTool.execute("claimable", { action: "start", agent: "researcher", message: "No authenticated model request", mode: "background" });
  await completedWithoutClaim(agentTool, third.structuredContent.runId);
  await agentTool.execute("claim", { action: "read", runId: third.structuredContent.runId });
  assert.equal((await boundary()).continue, false);
  assert.deepEqual(errors, []);
});

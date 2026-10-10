import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ExecutionService } from "../dist/application/execution.js";
import { openApplicationStorage } from "../dist/infrastructure/storage.js";
import { DurableIntentStore } from "../dist/infrastructure/durable-intent-store.js";
import { CliTools } from "../dist/infrastructure/integrations/cli-tools.js";
import { digest } from "../dist/infrastructure/digest.js";
import { TerminalApproval } from "../dist/interfaces/approval.js";

test("dispatch failure with a closed real store reports an error, closes writes and preserves recovery records", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ffa-dispatch-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = createModels(), registry = createRegistry();
  let storage = await openApplicationStorage(directory);
  let harness = await Harness.open(storage.storage, { models, registry }, context);
  t.after(async () => { await harness.close(context); await storage.close(); });
  const owner = await harness.root(context);
  const scope = { ownerId: owner.id, conversationId: owner.id, requestId: "request", roundId: "request", role: "coordinator" };
  const trading = await CliTools.open({ command: "/usr/bin/printf", operations: [{
    name: "print", description: "Local output only", access: "write", schema: { type: "object", additionalProperties: false }, argv: ["accepted"],
    outcomes: { accepted: { const: "accepted" }, rejected: { const: "rejected" } },
  }] }, directory);
  const store = new DurableIntentStore(harness);
  const approval = new TerminalApproval(undefined, false);
  const emergencies = [];
  const environment = { processEpoch: randomUUID(), id: randomUUID, now: () => new Date().toISOString(), hash: digest,
    isLive: candidate => candidate.ownerId === scope.ownerId && candidate.requestId === scope.requestId,
    emergency: message => emergencies.push(message) };
  const execution = new ExecutionService(store, trading, approval, environment);
  const intent = await execution.prepare(scope, { name: "print", parameters: {} }, "local-output");
  await store.commit(intents => {
    intents[0].state = "DispatchStarted";
    intents[0].attempt = { attemptId: "attempt", startedAt: environment.now(), sourceRef: "tool" };
    return { result: null, audit: [] };
  });
  const started = await store.read(intent.intentId);
  await harness.close(context); await storage.close();

  // Exercise the transport boundary directly. The real CLI receives an aborted signal,
  // so it cannot spawn; the closed durable store cannot save ProvenNotSent.
  await assert.rejects(execution.transmit(started, scope, AbortSignal.abort()), { code: "DISPATCH_STATE_UNCOMMITTED" });
  assert.equal(emergencies.length, 1);
  await assert.rejects(execution.execute(scope, intent.intentId, "retry"), { code: "EXECUTION_STORAGE_FAILED" });

  storage = await openApplicationStorage(directory);
  harness = await Harness.open(storage.storage, { models, registry }, context);
  const recoveredStore = new DurableIntentStore(harness);
  assert.equal((await recoveredStore.read(intent.intentId)).state, "DispatchStarted");
  const recovered = new ExecutionService(recoveredStore, trading, approval, { ...environment, processEpoch: randomUUID() });
  await recovered.recover();
  assert.equal((await recoveredStore.read(intent.intentId)).state, "Unknown");
  assert.equal((await recoveredStore.read(intent.intentId)).attempt.attemptId, "attempt");
  assert.equal((await recovered.execute(scope, intent.intentId, "retry")).state, "Unknown");
});

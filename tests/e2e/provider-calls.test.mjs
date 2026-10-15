import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initialize, rpcWorkspace } from "../helpers/pi-rpc.mjs";

// This CLI performs actual local calculations and appends their results to a file.
// The failing operation exits after writing; no external provider is simulated.
function registration(journal) {
  const code = [
    "import json, os, sys", "from pathlib import Path", "value = json.load(sys.stdin)['value'] ** 2",
    `with Path(${JSON.stringify(journal)}).open('a') as output:`,
    "    output.write(str(value) + '\\n')", "    output.flush()", "    os.fsync(output.fileno())",
  ].join("\n");
  const operation = (name, end) => ({
    name, description: "Calculate a square and append it to a local journal",
    inputSchema: { type: "object", required: ["value"], properties: { value: { type: "integer" } }, additionalProperties: false },
    argv: ["-I", "-c", code + "\n" + end], stdin: true,
  });
  return {
    action: "register", provider: "calculation", config: { kind: "cli", command: "python3" },
    coverage: { basis: "Python standard-library local calculation", limitations: ["No network or trading operations"] },
    operations: [operation("square", "print(json.dumps({'square': value}))"), operation("write_then_fail", "sys.exit(2)")],
    permissions: { square: "ask", write_then_fail: "ask" },
  };
}

async function record(pi, kind, id) {
  const saved = await pi.tool("ffa_provider_record", { kind, id });
  return saved.record;
}

async function registeredWorkspace(t) {
  const workspace = await rpcWorkspace(t);
  const pi = await workspace.start();
  await initialize(pi);
  const journal = join(workspace.root, "journal.txt");
  const request = registration(journal);
  const registered = await pi.confirm(() => pi.tool("ffa_provider_manage", request));
  assert.equal(registered.configSaved, true);
  assert.equal(registered.permissions.status, "complete");
  await assert.rejects(readFile(journal), { code: "ENOENT" });
  return { workspace, pi, journal };
}

test("E2E: RPC approval controls real CLI sends and receipts remain readable after restart", { timeout: 60_000 }, async t => {
  const { workspace, pi, journal } = await registeredWorkspace(t);
  const call = { provider: "calculation", operation: "square", parameters: { value: 6 } };
  const catalog = await pi.tool("ffa_providers", { provider: "calculation" });
  assert.ok(catalog.providers[0].operations.every(operation => operation.permission === "ask"));

  const declined = await pi.confirm(() => pi.execute("ffa_provider_call", call), false);
  assert.equal(declined.isError, true);
  assert.equal(declined.structuredContent.state, "declined");
  const declinedIntent = await record(pi, "intent", declined.structuredContent.intentId);
  assert.equal(declinedIntent.attempt, undefined);
  await assert.rejects(readFile(journal), { code: "ENOENT" });

  const sent = await pi.confirm(() => pi.tool("ffa_provider_call", call));
  assert.equal(sent.state, "observed");
  assert.equal(sent.success, true);
  assert.deepEqual(sent.data, { square: 36 });
  assert.equal(await readFile(journal, "utf8"), "36\n");
  const intent = await record(pi, "intent", sent.intentId);
  const receipt = await record(pi, "receipt", sent.receiptId);
  assert.ok(intent.attempt.id);
  assert.equal(intent.receiptId, receipt.id);
  assert.deepEqual(receipt.parameters, call.parameters);
  assert.equal(receipt.dataPath, sent.dataPath);
  assert.deepEqual(JSON.parse(await readFile(receipt.dataPath, "utf8")).data, sent.data);

  const permissions = await pi.tool("ffa_provider_manage", { action: "read", provider: "calculation", target: "permissions" });
  const updated = await pi.confirm(() => pi.tool("ffa_provider_manage", {
    action: "update", provider: "calculation", target: "permissions", mode: "set",
    expectedRevision: permissions.revision, permissions: { square: "deny" },
  }));
  assert.equal(updated.permissions.status, "complete");
  const files = await readdir(join(workspace.root, ".ffa/calls"));
  await assert.rejects(pi.tool("ffa_provider_call", call));
  assert.deepEqual(await readdir(join(workspace.root, ".ffa/calls")), files);
  assert.equal(await readFile(journal, "utf8"), "36\n");
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  const reopened = await workspace.start();
  assert.deepEqual(await record(reopened, "intent", sent.intentId), intent);
  assert.deepEqual(await record(reopened, "receipt", sent.receiptId), receipt);
  const current = await reopened.tool("ffa_provider_manage", { action: "read", provider: "calculation", target: "permissions" });
  assert.equal(current.effective.square, "deny");
  const stale = await reopened.execute("ffa_provider_manage", {
    action: "update", provider: "calculation", target: "permissions", mode: "set",
    expectedRevision: permissions.revision, permissions: { square: "allow" },
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.category, "conflict");
  await assert.rejects(reopened.tool("ffa_provider_call", call));
  assert.equal(await readFile(journal, "utf8"), "36\n");
  assert.deepEqual(await readdir(join(workspace.root, ".ffa/calls")), files);
  assert.deepEqual((await reopened.tool("ffa_status")).unknownCalls, []);
});

test("E2E: shutdown cancels a pending RPC approval and restart does not resume the call", { timeout: 60_000 }, async t => {
  const { workspace, pi, journal } = await registeredWorkspace(t);
  const confirmation = pi.waitFor(record => record.type === "extension_ui_request" && record.method === "confirm", pi.records.length);
  const call = { provider: "calculation", operation: "square", parameters: { value: 8 } };
  const interrupted = assert.rejects(pi.tool("ffa_provider_call", call));
  const request = await confirmation;
  const { intentId } = JSON.parse(request.message);
  const path = join(workspace.root, ".ffa/calls", intentId + ".json");
  const pending = JSON.parse(await readFile(path, "utf8"));
  assert.equal(pending.intent.state, "pending");
  assert.equal(pending.intent.attempt, undefined);
  await assert.rejects(readFile(journal), { code: "ENOENT" });
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
  await interrupted;

  const reopened = await workspace.start();
  const declined = await record(reopened, "intent", intentId);
  assert.equal(declined.state, "declined");
  assert.equal(declined.attempt, undefined);
  await assert.rejects(readFile(journal), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(workspace.root, ".ffa/calls")), [intentId + ".json"]);
  const explicit = await reopened.confirm(() => reopened.tool("ffa_provider_call", call));
  assert.notEqual(explicit.intentId, intentId);
  assert.equal(explicit.success, true);
  assert.equal(await readFile(journal, "utf8"), "64\n");
});

test("E2E: an uncertain local side effect survives restart without a settlement workflow or resend", { timeout: 60_000 }, async t => {
  const { workspace, pi, journal } = await registeredWorkspace(t);
  const failed = await pi.confirm(() => pi.execute("ffa_provider_call", {
    provider: "calculation", operation: "write_then_fail", parameters: { value: 7 },
  }));
  assert.equal(failed.isError, true);
  const result = failed.structuredContent;
  assert.equal(result.state, "unknown");
  assert.equal(result.success, false);
  assert.equal(await readFile(journal, "utf8"), "49\n");
  const intent = await record(pi, "intent", result.intentId);
  const receipt = await record(pi, "receipt", result.receiptId);
  assert.equal(JSON.parse(await readFile(receipt.dataPath, "utf8")).data.exitCode, 2);
  const path = join(workspace.root, ".ffa/calls", result.intentId + ".json");
  const before = JSON.parse(await readFile(path, "utf8"));
  assert.equal(before.events.filter(event => event.event === "dispatch_started").length, 1);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  const reopened = await workspace.start();
  const status = await reopened.tool("ffa_status");
  assert.deepEqual(status.unknownCalls, [intent]);
  assert.deepEqual(await record(reopened, "receipt", result.receiptId), receipt);
  assert.equal(await readFile(journal, "utf8"), "49\n");
  const note = "Checked the local journal: exactly one square was written before exit code 2.";
  await reopened.command(`/ffa resolve ${result.intentId} ${note}`);
  assert.deepEqual(await record(reopened, "intent", result.intentId), intent);
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(after, before);
  assert.equal(await readFile(journal, "utf8"), "49\n");
  assert.deepEqual(await readdir(join(workspace.root, ".ffa/calls")), [result.intentId + ".json"]);
});

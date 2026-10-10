import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grantMatches, markUnknown, observe, reprepare, resolveUnknown, reviewErrors, startAttempt, unresolved,
} from "../dist/domain/execution.js";

import { classifyWrite } from "../dist/infrastructure/integrations/write-result.js";
import { compileToolSchema } from "../dist/infrastructure/integrations/schema.js";

const scope = { ownerId: 1, requestId: "request" };
const binding = { connectionId: "service", epoch: "epoch", accessDigest: "access", schemaDigest: "schema" };
const operation = { name: "write", parameters: { value: 1 } };
function intent() {
  return {
    intentId: "intent", ownerId: 1, ownerRequestId: "request", revision: 1,
    operation: structuredClone(operation), operationDigest: "operation", binding: structuredClone(binding),
    state: "Proposed", attempt: null, observation: null, reconciliation: null, review: null,
  };
}
const attempt = { attemptId: "attempt", startedAt: "2026-10-10", sourceRef: "tool" };

test("write receipts need exactly one complete outcome match, independent of protocol success", () => {
  const accepted = compileToolSchema({ type: "object", properties: { status: { const: "accepted" }, id: { type: "string", minLength: 1 } }, required: ["status", "id"] });
  const rejected = compileToolSchema({ type: "object", properties: { status: { const: "rejected" } }, required: ["status"] });
  for (const [data, expected] of [
    [{ status: "accepted", id: "receipt" }, "accepted"],
    [{ status: "rejected" }, "rejected"],
    [{ status: "accepted" }, "unknown"],
    [{ items: [{ status: "accepted", id: "one" }, { status: "rejected" }] }, "unknown"],
  ]) {
    const receipt = { success: true, raw: {}, data };
    assert.equal(classifyWrite(receipt, accepted, rejected).outcome, expected);
    assert.equal(classifyWrite(receipt, accepted, accepted).outcome, "unknown");
  }
});

test("permission binds the process, owner, request, revision, operation and service", () => {
  const value = intent();
  const grant = { processEpoch: "process", intentId: value.intentId, revision: 1, binding,
    operationDigest: value.operationDigest, ownerId: 1, requestId: "request" };
  assert.equal(grantMatches(grant, value, scope, "process", binding), true);
  for (const change of [
    { processEpoch: "old" }, { intentId: "other" }, { revision: 2 },
    { ownerId: 2 }, { requestId: "other" }, { operationDigest: "other" },
  ]) assert.equal(grantMatches({ ...grant, ...change }, value, scope, "process", binding), false);
  for (const key of Object.keys(binding)) {
    const changed = { ...binding, [key]: "changed" };
    assert.equal(grantMatches(grant, value, scope, "process", changed), false);
    assert.equal(grantMatches({ ...grant, binding: changed }, value, scope, "process", binding), false);
  }
});

test("only a known outcome closes an attempt; no receipt can be overwritten or resent", () => {
  for (const outcome of ["accepted", "rejected", "unknown", undefined]) {
    const value = intent();
    assert.throws(() => observe(value, {}), { code: "OBSERVATION_CONFLICT" });
    startAttempt(value, attempt);
    assert.equal(unresolved(value), true);
    observe(value, { observedAt: "now", success: true, raw: {}, data: {}, outcome });
    assert.equal(value.state, outcome === "accepted" || outcome === "rejected" ? "Observed" : "Unknown");
    assert.throws(() => startAttempt(value, attempt), { code: "ALREADY_ATTEMPTED" });
    assert.throws(() => observe(value, {}), { code: "OBSERVATION_CONFLICT" });
    assert.throws(() => markUnknown(value), { code: "UNKNOWN_CONFLICT" });
  }
});

test("recovered unknown attempts require a nonempty human conclusion and cannot be sent again", () => {
  const value = intent();
  assert.throws(() => markUnknown(value), { code: "UNKNOWN_CONFLICT" });
  startAttempt(value, attempt);
  markUnknown(value);
  assert.equal(unresolved(value), true);
  assert.throws(() => resolveUnknown(value, "now", " "), { code: "RESOLUTION_INVALID" });
  resolveUnknown(value, "now", "External receipt checked");
  assert.equal(value.state, "Reconciled");
  assert.equal(unresolved(value), false);
  assert.equal(value.reconciliation.data.source, "terminal");
  assert.throws(() => startAttempt(value, attempt), { code: "ALREADY_ATTEMPTED" });
  assert.throws(() => reprepare(value, operation, binding, "new"), { code: "PREPARATION_CLOSED" });
});

test("changed preparation revokes review; review must match the complete operation", () => {
  const value = intent();
  value.review = { revision: 1 };
  reprepare(value, operation, binding, "operation");
  assert.equal(value.revision, 1);
  assert.notEqual(value.review, null);
  const changed = { ...operation, parameters: { value: 2 } };
  reprepare(value, changed, binding, "new");
  assert.equal(value.revision, 2);
  assert.equal(value.review, null);
  assert.deepEqual(reviewErrors({ decision: { action: "APPROVE", operation: changed }, operation: changed }), []);
  assert.deepEqual(reviewErrors({ decision: { action: "APPROVE", operation }, operation: changed }), ["exact_parameters_mismatch"]);
  assert.deepEqual(reviewErrors({ decision: { action: "invalid", operation }, operation }), ["invalid_review_action"]);
});

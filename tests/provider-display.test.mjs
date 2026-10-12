import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { operationSignature, operationSummary } from "../dist/ui/provider-display.js";

test("operation signatures keep required, optional, literal, array and union parameter types", () => {
  const inputSchema = { type: "object", additionalProperties: false, required: ["symbol", "quantity"], properties: {
    symbol: { type: "string" }, quantity: { type: "integer", minimum: 1 },
    side: { enum: ["buy", "sell"] }, tags: { type: "array", items: { type: "string" } },
    options: { type: "object", properties: { limit: { type: "number" } } },
    cursor: { anyOf: [{ type: "string" }, { type: "null" }] }, "special-key": { const: true },
  } };
  assert.equal(operationSignature({ name: "order", inputSchema }),
    'order(symbol: string, quantity: number, side?: "buy" | "sell", tags?: Array<string>, options?: object, cursor?: string | null, "special-key"?: true)');
  assert.equal(inputSchema.properties.quantity.minimum, 1);
});
test("open and unknown parameter schemas do not imply a closed empty signature", () => {
  assert.equal(operationSignature({ name: "open", inputSchema: { type: "object" } }), "open(...extra: unknown)");
  assert.equal(operationSignature({ name: "closed", inputSchema: { type: "object", additionalProperties: false } }), "closed()");
  assert.equal(operationSignature({ name: "refs", inputSchema: { type: "object", additionalProperties: false,
    properties: { item: { $ref: "#/definitions/item" }, values: { type: ["string", "null"] } } } }),
    "refs(item?: unknown, values?: string | null)");
  assert.equal(operationSignature({ name: "unsafe\x1b[2J", inputSchema: { type: "object", additionalProperties: false } }), "unsafe\\u001b[2J()");
});

test("long multiline provider documentation stays out of the compact summary and remains unchanged", () => {
  for (const separator of ["\n", "\r\n", "\\n", "\\r\\n"]) {
    const description = `短说明。${separator}${separator}${"// field: number".repeat(200)}`;
    const operation = { name: "query", description,
      inputSchema: { type: "object", required: ["code"], additionalProperties: false, properties: { code: { type: "string" } } } };
    const before = structuredClone(operation);
    const summary = operationSummary(operation);
    const rendered = new Text(summary, 0, 0).render(100);
    assert.equal(rendered.length, 2);
    assert.ok(summary.length < 100);
    assert.ok(!summary.includes("\\n"));
    assert.deepEqual(operation, before);
  }
  const operation = { name: "query", description: "说明🙂".repeat(200), inputSchema: { type: "object", additionalProperties: false } };
  const summary = operationSummary(operation);
  assert.equal(summary.split("\n").length, 2);
  assert.ok(visibleWidth(summary.split("\n")[1]) <= 82);
  assert.equal(new Text(summary, 0, 0).render(100).length, 2);
  assert.equal(operation.description.length, "说明🙂".repeat(200).length);
});

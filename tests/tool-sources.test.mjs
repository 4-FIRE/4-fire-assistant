import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { CliTools, parseCliConfig } from "../dist/infrastructure/integrations/cli-tools.js";
import { parseToolContract, openSource } from "../dist/infrastructure/tool-contracts.js";
import { parseWorkspaceSource, saveWorkspace, readWorkspace } from "../dist/infrastructure/workspace.js";
import { parseSourceConnection } from "../dist/infrastructure/config.js";
import { validInitializationEvidence, emptyWorkspace } from "../dist/domain/workspace.js";
import { ToolSources } from "../dist/infrastructure/integrations/tool-sources.js";

const operation = {
  name: "print", description: "Print one argument", access: "read",
  schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  argv: ["%s", { parameter: "value" }],
};
const contract = operations => ({ version: 1, sourceId: "local", operations });

test("source refresh retries failed CLI entries without restoring old bindings; cancellation preserves availability", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ffa-source-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, "printf");
  await copyFile("/usr/bin/printf", command);
  const recovering = await CliTools.open({ command, operations: [operation] }, directory);
  const healthy = await CliTools.open({ command: "/usr/bin/printf", operations: [operation] }, directory);
  const sources = new ToolSources(new Map([["recovering", recovering], ["healthy", healthy]]));
  const original = sources.binding("recovering/print");
  await assert.rejects(sources.refresh(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(sources.status().healthy.disabled, false);
  assert.equal(sources.status().recovering.disabled, false);
  assert.deepEqual(sources.binding("recovering/print"), original);

  await rm(command);
  await sources.refresh();
  assert.equal(sources.status().recovering.disabled, true);
  assert.equal(sources.status().healthy.disabled, false);
  assert.throws(() => sources.binding("recovering/print"), { code: "SOURCE_UNAVAILABLE" });
  assert.equal((await sources.read({ name: "healthy/print", parameters: { value: "available" } })).data, "available");
  await assert.rejects(sources.refresh(AbortSignal.abort()), { name: "AbortError" });
  assert.equal(sources.status().recovering.disabled, true);

  await copyFile("/usr/bin/printf", command);
  await sources.refresh();
  assert.equal(sources.status().recovering.disabled, false);
  const restored = sources.binding("recovering/print");
  assert.notEqual(restored.epoch, original.epoch);
  assert.equal(validInitializationEvidence({ success: true, binding: original }, restored), false);
  assert.equal((await sources.read({ name: "recovering/print", parameters: { value: "restored" } })).data, "restored");
  await sources.refresh();
  assert.deepEqual(sources.binding("recovering/print"), restored);
});

test("native contracts reject ambiguous argv and implicit credentials; trading review cannot be disabled", () => {
  assert.throws(() => parseCliConfig({ command: "/cli", operations: [operation, operation] }));
  assert.throws(() => parseCliConfig({ command: "/cli", operations: [{ ...operation, argv: ["print"] }] }));
  assert.throws(() => parseCliConfig({ command: "/cli", env: { KEY: "secret value" }, operations: [operation] }));
  assert.throws(() => parseToolContract(contract([{ ...operation, roles: [] }])));
  assert.throws(() => parseToolContract(contract([{ ...operation, access: "write", roles: ["coordinator"], execution: { reviewRequired: false, confirmationRequired: true } }])));
  const write = parseToolContract(contract([{ ...operation, access: "write", roles: ["coordinator"] }])).operations[0];
  assert.deepEqual(write.execution, { reviewRequired: true, confirmationRequired: true });
  for (const dialect of ["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2019-09/schema"]) {
    assert.equal(parseToolContract(contract([{ ...operation, schema: { ...operation.schema, $schema: dialect }, roles: ["coordinator"] }])).operations[0].schema.$schema, dialect);
  }
  const mcp = parseWorkspaceSource("remote", { connection: { transport: "http", url: "https://example.invalid/mcp" }, operations: [{ name: "query", access: "read", roles: ["coordinator"] }] });
  assert.equal(mcp.operations[0].schema, undefined);
  assert.throws(() => parseWorkspaceSource("local", { connection: { transport: "cli", command: "/cli" }, operations: [{ name: "query", access: "read", roles: ["coordinator"] }] }));
  assert.throws(() => parseSourceConnection({ transport: "stdio", command: "program", env: { KEY: "secret value" } }));
});

test("invalid source ids do not invalidate a fresh workspace; corrected MCP inputs save without migration", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ffa-source-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = emptyWorkspace();
  await saveWorkspace(directory, initial);
  const input = {
    connection: { transport: "http", url: "https://example.invalid/mcp" },
    operations: [{ name: "query", access: "read", roles: ["coordinator", "researcher", "reviewer"] }],
  };
  for (const id of ["options_trade", "Options", "../source", "a".repeat(65), ""]) {
    assert.throws(() => parseWorkspaceSource(id, input), { code: "SOURCE_ID_INVALID" });
  }
  assert.throws(() => parseWorkspaceSource("valid", { ...input, unsupported: true }), { code: "SOURCE_CONFIG_INVALID" });
  assert.throws(() => parseWorkspaceSource("valid", { ...input, operations: [] }), { code: "SOURCE_CONFIG_INVALID" });
  assert.deepEqual(await readWorkspace(directory), initial);
  const checked = parseWorkspaceSource("options-trade", input);
  const configured = { ...initial, sources: { "options-trade": checked } };
  await saveWorkspace(directory, configured);
  assert.deepEqual(await readWorkspace(directory), configured);
});

test("real printf keeps shell characters in one argv; permissions and current connection bind evidence", async () => {
  const source = await openSource({ transport: "cli", command: "/usr/bin/printf" }, parseToolContract(contract([{ ...operation, roles: ["coordinator"] }])), tmpdir());
  try {
    const value = "spaces; $(exit 9) 'quotes'\nnext";
    const call = { name: "print", parameters: { value } };
    assert.equal(source.tools.allowed("print", "coordinator"), true);
    assert.equal(source.tools.allowed("print", "reviewer"), false);
    assert.deepEqual(source.tools.preview(call).argv, ["%s", value]);
    const receipt = await source.tools.read(call);
    assert.equal(receipt.success, true);
    assert.equal(receipt.data, value);
    const binding = source.tools.binding("print");
    assert.equal(validInitializationEvidence({ success: true, binding }, binding), true);
    assert.equal(validInitializationEvidence({ success: false, binding }, binding), false);
    assert.equal(validInitializationEvidence({ success: true }, binding), false);
    assert.equal(validInitializationEvidence(undefined, binding), false);
    const reopened = await CliTools.open({ command: "/usr/bin/printf", operations: [operation] }, tmpdir());
    assert.equal(validInitializationEvidence({ success: true, binding }, reopened.binding("print")), false);
    await assert.rejects(source.tools.read({ name: "print", parameters: {} }));
  } finally { await source.close(); }
});

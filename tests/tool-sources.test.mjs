import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliConfig } from "../dist/infrastructure/integrations/cli-tools.js";
import { parseToolContract } from "../dist/infrastructure/tool-contracts.js";
import { saveInitialization } from "../dist/infrastructure/complete-initialization.js";
import { locateWorkspace, readWorkspace } from "../dist/infrastructure/workspace.js";
import { readConfig, writeConfig, parseConfig } from "../dist/infrastructure/config.js";
import { emptyWorkspace } from "../dist/domain/workspace.js";

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "ffa-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const operation = {
  name: "lookup", description: "Lookup", access: "read",
  schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  argv: ["lookup", { parameters: "json" }],
};
const contract = id => ({ version: 1, sourceId: id, operations: [{ ...operation, roles: ["coordinator"] }] });

test("contracts reject writes, duplicate operations, unspecified argv and implicit environment values", () => {
  assert.throws(() => parseCliConfig({ command: "/cli", operations: [{ ...operation, access: "write" }] }));
  assert.throws(() => parseCliConfig({ command: "/cli", operations: [operation, operation] }));
  assert.throws(() => parseCliConfig({ command: "/cli", operations: [{ ...operation, argv: ["lookup"] }] }));
  assert.throws(() => parseCliConfig({ command: "/cli", env: { KEY: "secret value" }, operations: [operation] }));
  assert.throws(() => parseToolContract({ ...contract("test"), sourceId: "../escape" }));
  assert.throws(() => parseToolContract({ ...contract("test"), operations: [{ ...operation, roles: [] }] }));
  for (const dialect of ["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2019-09/schema"]) {
    assert.equal(parseToolContract({ ...contract("test"), operations: [{ ...operation, schema: { ...operation.schema, $schema: dialect }, roles: ["coordinator"] }] }).operations[0].schema.$schema, dialect);
  }
});

test("connection identity conflicts preserve existing machine settings and keep workspace pending", async t => {
  const root = await temp(t), machine = join(root, "machine"), workspace = await locateWorkspace(root, async () => true);
  await writeConfig(machine, { version: 1, sources: { local: { transport: "cli", command: "/original" } } });
  const config = emptyWorkspace(); config.initialization = "complete";
  config.draft.sources.push({ id: "local", kind: "cli", name: "test", location: "/new", description: "", missing: [], connection: { transport: "cli", command: "/new" }, operations: contract("local").operations });
  await assert.rejects(saveInitialization(workspace, machine, config), { code: "SOURCE_ID_CONFLICT" });
  assert.equal((await readConfig(machine)).sources.local.command, "/original");
  assert.equal((await readWorkspace(workspace)).initialization, "pending");
  assert.equal(parseConfig({ version: 1, sources: { local: { transport: "cli", command: "/cli", env: { HOME: "HOME" } } } }).sources.local.env.HOME, "HOME");
});

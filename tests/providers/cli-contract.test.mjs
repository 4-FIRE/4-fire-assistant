import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProvider, providerData } from "../../dist/storage/provider-config.js";
import { runCommand } from "../../dist/integrations/process.js";

const cli = { id: "local", kind: "cli", coverage: { basis: "Local CLI contract", limitations: ["Only the documented test commands"] }, command: "printf", operations: [{
  name: "print", description: "Print a literal argument",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  argv: ["%s", { parameter: "text" }]
}] };
test("CLI contracts require explicit binding and credential references", () => {
  assert.deepEqual(providerData(parseProvider(cli)), cli);
  assert.throws(() => parseProvider({ ...cli, env: { SECRET: "literal-secret" } }));
  for (const command of ["/usr/bin/printf", "./printf", "bin/printf", "printf --help", "printf;true", "printf\0", ".", ".."]) {
    assert.throws(() => parseProvider({ ...cli, command }));
  }
  assert.throws(() => parseProvider({ ...cli, operations: [{ ...cli.operations[0], argv: [] }] }));
  assert.throws(() => parseProvider({ ...cli, operations: [{ ...cli.operations[0], unknownField: true }] }));
});
test("real process arguments do not interpret shell metacharacters", async () => {
  const literal = "$(echo unsafe); & | >";
  const value = await runCommand("/usr/bin/printf", ["%s", literal], undefined, process.cwd(), {});
  assert.equal(value.success, true);
  assert.equal(value.data.stdout, literal);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirectory, parseConfig, parseModel, readConfig, writeConfig } from "../dist/infrastructure/application-config.js";
import { parseSourceConnection } from "../dist/infrastructure/integrations/connection-config.js";

test("default data paths are fixed, ignore relative XDG, and require absolute overrides", () => {
  const home = "/isolated/home";
  assert.equal(dataDirectory({ home, env: {} }), join(home, ".local/share/4-fire-assistant"));
  assert.equal(dataDirectory({ home, env: { XDG_DATA_HOME: "/isolated/xdg" } }), "/isolated/xdg/4-fire-assistant");
  assert.equal(dataDirectory({ home, env: { XDG_DATA_HOME: "relative" } }), join(home, ".local/share/4-fire-assistant"));
  assert.throws(() => dataDirectory({ override: "relative" }), { code: "INVALID_DATA_DIR" });
});
test("model id may contain slashes; malformed config does not echo input", () => {
  assert.deepEqual(parseModel("openrouter/anthropic/model"), { provider: "openrouter", modelId: "anthropic/model" });
  for (const model of ["", "/model", "provider/", " provider/model"]) assert.throws(() => parseModel(model));
  assert.throws(() => parseConfig({ version: 2, password: "secret" }), /原文件未修改/);
  assert.throws(() => parseConfig({ version: 1, authPath: "relative" }), { code: "INVALID_CONFIG" });
  assert.equal(parseConfig({ version: 1, runtime: { generationRetries: 0 } }).runtime.generationRetries, 0);
  for (const runtime of [{ generationRetries: -1 }, { generationRetries: 11 }, { modelTimeoutMs: 1.5 }, { tradeRetries: 1 }]) {
    assert.throws(() => parseConfig({ version: 1, runtime }), { code: "INVALID_CONFIG" });
  }
  for (const url of ["https://user:credential-secret@example.invalid", "https://example.invalid?key=credential-secret"]) {
    assert.throws(() => parseSourceConnection({ transport: "http", url }),
      error => error.code === "INVALID_CONFIG" && !error.message.includes("credential-secret"));
  }
});
test("configuration enums reject non-string values without coercion", () => {
  for (const thinkingLevel of [["high"], null, 1, {}]) {
    assert.throws(() => parseConfig({ version: 1, thinkingLevel }), { code: "INVALID_CONFIG" });
  }
  assert.equal(parseConfig({ version: 1, thinkingLevel: "high" }).thinkingLevel, "high");
  for (const transport of [["stdio"], null, 1, {}]) {
    assert.throws(() => parseSourceConnection({ transport, command: "program" }), { code: "INVALID_CONFIG" });
  }
  for (const apiKeyHeader of [["Authorization"], null, 1, {}]) {
    assert.throws(() => parseSourceConnection({ transport: "http", url: "https://example.invalid", apiKeyHeader }), { code: "INVALID_CONFIG" });
  }
  assert.equal(parseSourceConnection({ transport: "http", url: "https://example.invalid", apiKeyHeader: "Authorization" }).apiKeyHeader, "Authorization");
});

test("config is private and atomic; invalid JSON is preserved, not replaced", async t => {
  const directory = await mkdtemp(join(tmpdir(), "4fire-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readConfig(directory), { version: 1 });
  const config = { version: 1, model: { provider: "faux", modelId: "faux-1" } };
  await writeConfig(directory, config);
  assert.deepEqual(await readConfig(directory), config);
  if (process.platform !== "win32") assert.equal((await stat(join(directory, "config.local.json"))).mode & 0o777, 0o600);
  await writeFile(join(directory, "config.local.json"), '{"password":"secret",');
  await assert.rejects(readConfig(directory), error => error.code === "INVALID_CONFIG" && !error.message.includes("secret"));
  assert.equal(await readFile(join(directory, "config.local.json"), "utf8"), '{"password":"secret",');
  await assert.rejects(writeConfig(directory, { version: 4 }), { code: "INVALID_CONFIG" });
  assert.equal(await readFile(join(directory, "config.local.json"), "utf8"), '{"password":"secret",');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { agentModelRuntime } from "../dist/integrations/pi-agents.js";
import { agentLoader } from "../dist/integrations/agent-resources.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent runtime uses host auth for the real OAuth-only Codex provider without copying credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "ffa-agent-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(host);
  const model = host.getModels("openai-codex")[0];
  assert.ok(model);
  assert.equal(host.getProvider(model.provider).auth.apiKey, undefined);
  // Local non-secret values test auth resolution only. No model requests are sent.
  await host.setRuntimeApiKey(model.provider, "local-auth-value");
  assert.equal(await host.checkAuth(model.provider), undefined);
  host.registerProvider(model.provider, { apiKey: "local-host-value", headers: { "X-Local-Auth": "first" } });
  await host.removeRuntimeApiKey(model.provider);
  const child = await agentModelRuntime(registry, model);
  assert.ok(await child.checkAuth(model.provider));
  assert.equal((await child.getAuth(model)).auth.apiKey, "local-host-value");
  assert.equal((await child.getAuth(model)).auth.headers["X-Local-Auth"], "first");
  assert.deepEqual(await child.listCredentials(), []);
  host.registerProvider(model.provider, { apiKey: "changed-host-value", headers: { "X-Local-Auth": "second" } });
  assert.equal((await child.getAuth(model)).auth.apiKey, "changed-host-value");
  assert.equal((await child.getAuth(model)).auth.headers["X-Local-Auth"], "second");
  const { session } = await createAgentSession({ cwd: root, model, modelRuntime: child,
    sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory(),
    resourceLoader: await agentLoader(root, "reviewer"), tools: ["read"] });
  t.after(() => session.dispose());
  assert.equal(session.model.provider, model.provider);
  assert.deepEqual(await child.listCredentials(), []);
});

test("agent runtime does not mark an unauthenticated Codex host as available", async () => {
  const host = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = host.getModels("openai-codex")[0];
  const child = await agentModelRuntime(new ModelRegistry(host), model);
  assert.equal(await child.checkAuth(model.provider), undefined);
  assert.equal(await child.getAuth(model), undefined);
  assert.deepEqual(await child.listCredentials(), []);
});

test("agent auth resolves host OAuth credentials and observes local credential changes", async () => {
  const credentials = new InMemoryCredentialStore();
  // Non-secret credential records exercise the real SDK's OAuth derivation, not a model request.
  const credential = { type: "oauth", access: "local-oauth-access", refresh: "local-oauth-refresh",
    expires: Date.now() + 3_600_000 };
  await credentials.modify("openai-codex", async () => credential);
  const host = await ModelRuntime.create({ credentials, modelsPath: null });
  const model = host.getModels("openai-codex")[0];
  const child = await agentModelRuntime(new ModelRegistry(host), model);
  assert.equal((await child.checkAuth(model.provider)).type, "oauth");
  assert.equal((await child.getAuth(model)).auth.apiKey, credential.access);
  await credentials.modify(model.provider, async () => ({ ...credential, access: "changed-oauth-access" }));
  assert.equal((await child.getAuth(model)).auth.apiKey, "changed-oauth-access");
  await host.logout(model.provider);
  assert.equal(await child.checkAuth(model.provider), undefined);
  assert.equal(await child.getAuth(model), undefined);
  assert.deepEqual(await child.listCredentials(), []);
});

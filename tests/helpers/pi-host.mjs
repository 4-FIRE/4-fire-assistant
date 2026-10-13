import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { begin } from "../../dist/storage/workspace-state.js";
import { finish } from "../../dist/services/initialization-service.js";
import { Store } from "../../dist/storage/store.js";
import { parseProvider, providerData } from "../../dist/services/provider-config.js";

export async function host(t, status, providers = [], permissions = { default: "ask", tools: { "local/echo": "allow", "local/write": "review" } }) {
  const temp = await mkdtemp(join(tmpdir(), "ffa-pi-")), root = join(temp, "workspace"), agentDir = join(temp, "agent");
  await mkdir(root); await mkdir(agentDir);
  if (status) {
    await begin(root);
    if (status === "ready" || providers.length) {
      await mkdir(join(root, "providers"));
      await writeFile(join(root, ".ffa/permissions.json"), JSON.stringify(permissions));
    }
    const store = new Store(join(root, ".ffa"));
    for (const provider of providers) store.put("provider", provider.id, providerData(parseProvider(provider)));
    store.close();
    if (status === "ready") await finish(root, "test-market");
  }
  const settingsManager = SettingsManager.inMemory({ packages: [resolve(".")], defaultTools: ["+codemode"] });
  let api;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ models: false }), pi => { api = pi; }] });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: runtime, model: runtime.getModels("openai-codex")[0],
    sessionManager: SessionManager.create(root, join(temp, "sessions")) });
  const errors = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); session.dispose();
    await rm(temp, { recursive: true, force: true });
  });
  assert.deepEqual(errors, []);
  return { root, loader, session, errors, api };
}

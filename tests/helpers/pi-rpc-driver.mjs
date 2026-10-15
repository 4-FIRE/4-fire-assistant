import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, runRpcMode, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Real SDK/RPC host. IPC submits explicit tool inputs, not generated model responses.
// Confirmations still travel through Pi's native stdin/stdout RPC UI protocol.
const [root, agentDir, packagePath] = process.argv.slice(2);
const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
  });
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory({ packages: [packagePath], retry: { enabled: false } }),
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  return {
    ...await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, model: modelRuntime.getModels("openai-codex")[0],
    }),
    services, diagnostics: services.diagnostics,
  };
}, { cwd: root, agentDir, sessionManager: SessionManager.create(root, join(agentDir, "sessions")) });

process.on("message", async ({ id, action, name, input }) => {
  try {
    const session = runtime.session;
    let value;
    if (action === "inspect") {
      value = {
        tools: session.getCallableToolNames(),
        skills: runtime.services.resourceLoader.getSkills().skills.map(skill => skill.name),
      };
    } else if (action === "idle") {
      await session.waitForIdle();
    } else if (action === "execute") {
      const tool = session.agent.state.tools.find(tool => tool.name === name);
      assert.ok(tool, `Tool is not active: ${name}`);
      value = await tool.execute(id, input);
    } else {
      throw new Error(`Unknown driver action: ${action}`);
    }
    process.send({ type: "driver_response", id, success: true, value });
  } catch (error) {
    process.send({ type: "driver_response", id, success: false, error: error.stack ?? String(error) });
  }
});
await runRpcMode(runtime);

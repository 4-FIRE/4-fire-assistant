import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Store } from "./storage/store.js";
import { ProviderConnections } from "./integrations/providers/provider-connections.js";
import { PiAgents } from "./integrations/pi/pi-agents.js";
import { bindAgentRun } from "./extension/agent-run.js";
import { ProviderRegistry } from "./services/providers/provider-registry.js";
import { ExecutionService } from "./services/execution/execution-service.js";
import { InitializationService } from "./services/workspace/initialization-service.js";
import { ResearchService } from "./services/research/research-service.js";
import { RecordService } from "./services/execution/record-service.js";
import { AgentService } from "./services/agents/agent-service.js";
import { Confirmations } from "./ui/confirmation.js";
import { ToolRegistry, mainTools } from "./tools/register.js";
import { Lifecycle, WorkspaceInstance } from "./extension/lifecycle.js";
import { registerCommand } from "./extension/command.js";
import { registerEvents } from "./extension/events.js";
import { registerAgentEvents } from "./extension/agent-events.js";

/** Loading the extension creates no files, connections, processes or timers. */
export default function ffa(pi: ExtensionAPI) {
  const confirmations = new Confirmations(), registry = new ToolRegistry(pi), agentHost = new PiAgents();
  const lifecycle = new Lifecycle((root, current) => {
    const store = new Store(join(root, ".ffa"), false);
    const connections = new ProviderConnections(root);
    try {
      const providers = new ProviderRegistry(store, connections, root);
      const execution = new ExecutionService(providers, store);
      if (current.status === "ready") providers.permissions.read();
      return new WorkspaceInstance(root, store, providers, execution,
        new InitializationService(root, current, providers), new ResearchService(root, store.settings),
        new RecordService(store.calls), new AgentService(execution));
    } catch (error) { store.close(); throw error; }
  }, instance => registry.register(mainTools(instance, instance, confirmations,
    ctx => bindAgentRun(pi, agentHost, instance.providers, instance.records, instance.research, instance, ctx, confirmations))),
  () => registry.hide());
  registerCommand(pi, lifecycle, confirmations);
  registerEvents(pi, lifecycle, confirmations);
  registerAgentEvents(pi, lifecycle, confirmations);
}

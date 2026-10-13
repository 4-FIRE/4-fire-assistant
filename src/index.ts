import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Store } from "./storage/store.js";
import { ProviderConnections } from "./integrations/provider-connections.js";
import { PiAgents } from "./integrations/pi-agents.js";
import { bindAgentRun } from "./integrations/agent-tools.js";
import { ProviderRegistry } from "./services/provider-registry.js";
import { ExecutionService } from "./services/execution-service.js";
import { InitializationService } from "./services/initialization-service.js";
import { WorkspaceUpdateService } from "./services/workspace-update-service.js";
import { ResearchService } from "./services/research-service.js";
import { RecordService } from "./services/record-service.js";
import { AgentService } from "./services/agent-service.js";
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
    const store = new Store(join(root, ".ffa"), current.status === "pending");
    const connections = new ProviderConnections(root);
    try {
      const providers = new ProviderRegistry(store, connections, root);
      const execution = new ExecutionService(providers, store);
      if (current.status === "ready") providers.permissions.read();
      return new WorkspaceInstance(root, store, providers, execution,
        new InitializationService(root, current, store, providers), new ResearchService(root, store),
        new RecordService(store), new AgentService(execution), new WorkspaceUpdateService(root, store));
    } catch (error) { store.close(); throw error; }
  }, instance => registry.register(mainTools(instance, instance, confirmations,
    ctx => bindAgentRun(pi, agentHost, instance.providers, instance.records, instance.research, instance, ctx, confirmations))),
  () => registry.hide());
  registerCommand(pi, lifecycle, confirmations);
  registerEvents(pi, lifecycle, confirmations);
  registerAgentEvents(pi, lifecycle, confirmations);
}

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Store } from "./storage/store.js";
import { SourceConnections } from "./integrations/source-connections.js";
import { PiExperts } from "./integrations/pi-experts.js";
import { bindExpertRun } from "./integrations/expert-tools.js";
import { SourceService } from "./services/source-service.js";
import { ExecutionService } from "./services/execution-service.js";
import { InitializationService } from "./services/initialization-service.js";
import { ResearchService } from "./services/research-service.js";
import { RecordService } from "./services/record-service.js";
import { ExpertService } from "./services/expert-service.js";
import { Confirmations } from "./ui/confirmation.js";
import { ToolRegistry, mainTools } from "./tools/register.js";
import { Lifecycle, WorkspaceInstance } from "./extension/lifecycle.js";
import { registerCommand } from "./extension/command.js";
import { registerEvents } from "./extension/events.js";

/** Loading the extension creates no files, connections, processes or timers. */
export default function ffa(pi: ExtensionAPI) {
  const confirmations = new Confirmations(), registry = new ToolRegistry(pi), expertHost = new PiExperts();
  const lifecycle = new Lifecycle((root, current) => {
    const store = new Store(join(root, ".ffa"), current.status === "pending");
    const connections = new SourceConnections(root);
    try {
      const sources = new SourceService(store, connections, () => execution.revoke());
      const execution = new ExecutionService(sources, store);
      return new WorkspaceInstance(root, store, sources, execution,
        new InitializationService(root, current, store, sources), new ResearchService(root, store),
        new RecordService(store), new ExpertService(sources, execution));
    } catch (error) { store.close(); throw error; }
  }, instance => registry.register(mainTools(instance, instance, confirmations,
    (ctx, signal, progress) => bindExpertRun(pi, expertHost, instance.sources, instance.records, instance.research, instance, ctx, signal, progress))),
  () => registry.hide());
  registerCommand(pi, lifecycle, confirmations);
  registerEvents(pi, lifecycle, confirmations);
}

import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../services/providers/provider-registry.js";
import type { RecordService } from "../services/execution/record-service.js";
import type { AgentRun } from "../services/agents/agent-service.js";
import type { AgentExecution } from "../model/agent.js";
import type { CallAccess } from "../tools/access.js";
import { providersTool } from "../tools/providers/catalog.js";
import { providerCallTool } from "../tools/providers/call.js";
import { providerRecordTool } from "../tools/providers/record.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { PiAgents } from "../integrations/pi/pi-agents.js";
import { agentFileTools } from "../integrations/pi/agent-tools.js";
import { assertAgentBranch } from "../integrations/pi/agent-context.js";

export function bindAgentRun(pi: ExtensionAPI, host: PiAgents, providers: ProviderRegistry, records: RecordService,
  access: CallAccess, ctx: ExtensionToolContext, confirmations: Confirmations) {
  const sessionId = ctx.sessionManager.getSessionId();
  let leaf = ctx.sessionManager.getLeafId(), anchored = false;
  const save = (value: AgentExecution) => {
    assertAgentBranch(ctx.sessionManager, sessionId, leaf);
    pi.appendEntry("ffa.agent-run", value);
    if (!anchored) { leaf = ctx.sessionManager.getLeafId(); anchored = true; }
  };
  const run: AgentRun = async (task, signal, progress, control) => {
    const check = (ready?: boolean) => { access.check(ready); signal.throwIfAborted(); assertAgentBranch(ctx.sessionManager, sessionId, leaf); };
    check(true);
    const childAccess: CallAccess = {
      check, signal: inner => AbortSignal.any([signal, ...(inner ? [inner] : [])]),
      scope: () => access.scope(sessionId),
      authorizeFile: (path, change, confirm, cancel) => access.authorizeFile(path, change, confirm, cancel),
    };
    const confirm = async (value: unknown, cancel: AbortSignal, recheck: () => Promise<void>) => {
      progress({ activity: "等待批准" });
      try { return await confirmations.ask(ctx, "批准专家本次工具调用", value, cancel, undefined, recheck); }
      finally { progress({ activity: "工具调用" }); }
    };
    const tools: ToolDefinition[] = [
      providersTool(providers, childAccess),
      providerCallTool({ call: (_scope, provider, operation, parameters, _confirm, callSignal) =>
        task.call(provider, operation, parameters, (value, recheck) => confirm(value, childAccess.signal(callSignal), recheck), callSignal)
      }, childAccess, confirmations),
      providerRecordTool(records, childAccess),
      ...agentFileTools(ctx.cwd, signal, (path, change, cancel) => childAccess.authorizeFile(path, change,
        value => confirmations.ask(ctx, "确认修改工作区外文件", value, cancel), cancel)),
    ];
    return host.run(ctx, task.agent, task.message, tools, task.previous, signal, progress, control);
  };
  return { run, save };
}

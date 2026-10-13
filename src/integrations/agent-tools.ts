import { access as fileAccess, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { defineTool, createWriteToolDefinition, createEditToolDefinition,
  type ExtensionAPI, type ExtensionToolContext, type ToolDefinition, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { ProviderRegistry } from "../services/provider-registry.js";
import type { RecordService } from "../services/record-service.js";
import type { ResearchService } from "../services/research-service.js";
import type { AgentRun } from "../services/agent-service.js";
import type { AgentExecution } from "../model/agent.js";
import type { CallAccess } from "../tools/access.js";
import { providersTool } from "../tools/providers.js";
import { providerCallTool } from "../tools/provider-call.js";
import type { Confirmations } from "../ui/confirmation.js";
import { pythonTool } from "../tools/python.js";
import { PiAgents } from "./pi-agents.js";

/** Native tools still own parsing, mutation queues and results; authorize at the actual file write. */
export function agentFileTools(root: string, access: CallAccess, ctx: ExtensionToolContext,
  signal: AbortSignal, confirmations: Confirmations): ToolDefinition[] {
  const guardedWrite = (cancel: AbortSignal, parameters: unknown) => async (path: string, content: string) => {
    await access.authorizeFile(path, { parameters, content },
      value => confirmations.ask(ctx, "确认修改工作区外文件", value, cancel), cancel);
    await mkdir(dirname(path), { recursive: true });
    cancel.throwIfAborted();
    await writeFile(path, content, "utf8");
  };
  return [
    defineTool({ ...createWriteToolDefinition(root),
      execute(id, args, inner, update, child) {
        const cancel = AbortSignal.any([signal, ...(inner ? [inner] : [])]);
        return createWriteToolDefinition(root, { operations: {
          // Directory creation belongs to guardedWrite, after authorization.
          mkdir: async () => {}, writeFile: guardedWrite(cancel, args),
        } }).execute(id, args, cancel, update, child);
      },
    }),
    defineTool({ ...createEditToolDefinition(root),
      execute(id, args, inner, update, child) {
        const cancel = AbortSignal.any([signal, ...(inner ? [inner] : [])]);
        return createEditToolDefinition(root, { operations: {
          readFile, access: path => fileAccess(path, constants.R_OK | constants.W_OK), writeFile: guardedWrite(cancel, args),
        } }).execute(id, args, cancel, update, child);
      },
    }),
  ];
}

export function bindAgentRun(pi: ExtensionAPI, host: PiAgents, providers: ProviderRegistry, records: RecordService,
  research: ResearchService, access: CallAccess, ctx: ExtensionToolContext, confirmations: Confirmations) {
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
      }, records, childAccess, confirmations),
      pythonTool(research, childAccess),
      ...agentFileTools(ctx.cwd, childAccess, ctx, signal, confirmations),
    ];
    return host.run(ctx, task.agent, task.message, tools, task.previous, signal, progress, control);
  };
  return { run, save };
}

export function assertAgentBranch(manager: Pick<SessionManager, "getSessionId" | "getBranch">, sessionId: string, ancestor: string | null) {
  if (manager.getSessionId() !== sessionId || ancestor !== null && !manager.getBranch().some(entry => entry.id === ancestor)) {
    throw new Error("专家调用所属会话分支已变化。");
  }
}

import type { Static } from "typebox";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AgentExecution } from "../../model/agent.js";
import type { AgentService, AgentRun } from "../../services/agents/agent-service.js";
import type { CallAccess } from "../access.js";
import { agentDefinitions } from "../../integrations/pi/agent-resources.js";
import { agentCard } from "../../ui/agent-display.js";
import { agentActionSchema, agentParametersSchema, agentResultSchema } from "./contract.js";
import { agentContext } from "../../integrations/pi/agent-context.js";
import { result } from "../result.js";
import { requireThat, schema } from "../../common/validation.js";

export type BindAgentRun = (ctx: ExtensionToolContext) => { run: AgentRun; save(value: AgentExecution): void };
function agentPage(value: AgentExecution, offset = 0, limit = 16000) {
  requireThat(offset <= value.report.length, "分页位置超出报告。");
  const { session, ...execution } = value;
  return { ...execution, ...(session ? { checkpoint: { file: session.file, leaf: session.leaf } } : {}),
    report: value.report.slice(offset, offset + limit), totalLength: value.report.length,
    nextOffset: offset + limit < value.report.length ? offset + limit : null };
}
function agentResult(service: AgentService, runIds: Set<string>, value: unknown, failed = false) {
  const reported = service.usage(runIds), output = result(value, failed);
  return { ...output, details: { ...output.details as object, agentUsageRunIds: reported.runIds }, usage: reported.usage };
}
export function agentTool(service: AgentService, access: CallAccess, bindRun: BindAgentRun) {
  const valid = schema(agentActionSchema);
  return defineTool({
    name: "ffa_agent", label: "专家协作",
    description: "唯一专家入口。start 用 agent 职责名和 message 新建执行；continue 用已结束的 runId 和 message 从该检查点接续。mode 默认 foreground，background 显式后台。运行中补充用 steer、runId、message，不用 continue。list 列出 agents/runs；read/wait/stop 均用 runId，read/wait 可分页。steer 返回 messageStatus=queued/handled，不表示模型已阅读。复核 reviewer 必须 start 新上下文。默认交回报告，仅用户要求时修改资料；失败不自动重跑，报告不授予业务许可。",
    parameters: agentParametersSchema, outputSchema: agentResultSchema,
    renderCall: (args, theme) => new Text(theme.style(`● 专家 ${args.action ?? ""}`, { fg: "accent", bold: true }) +
      theme.fg("dim", "agent" in args ? " · " + args.agent : "runId" in args ? " · " + args.runId?.slice(0, 8) : ""), 0, 0),
    renderResult: (output, options, theme, context) => {
      const value = output.details as AgentExecution | undefined;
      const background = options.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
      return value?.runId ? agentCard(value, options.expanded, theme, background)
        : new Text(output.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 0, 0);
    },
    async execute(_id, args, signal, onUpdate, ctx) {
      access.check(true);
      requireThat(valid(args), "专家操作参数无效；请按 action 提供 agent、runId、message、mode 或分页参数。");
      const input = args as Static<typeof agentActionSchema>;
      const { values, runIds, reported } = agentContext(ctx.sessionManager);
      service.restore(values, reported);
      if (input.action === "list") return agentResult(service, runIds, {
        agents: await agentDefinitions(ctx.cwd), runs: service.list(runIds).map(value => agentPage(value, 0, 240)),
      });
      if (input.action === "start" || input.action === "continue") {
        const agent = input.action === "start" ? input.agent : service.read(input.runId, runIds, false).agent;
        requireThat((await agentDefinitions(ctx.cwd)).includes(agent), "未知专家职责。");
        const background = input.mode === "background", cancel = access.signal(background ? undefined : signal, background);
        signal?.throwIfAborted(); ctx.signal?.throwIfAborted();
        const { run, save } = bindRun(ctx);
        const runId = service.start({ agent, message: input.message, mode: input.mode ?? "foreground",
          ...(input.action === "continue" ? { runId: input.runId } : {}) }, runIds,
          access.scope(ctx.sessionManager.getSessionId()), run, cancel, save);
        runIds.add(runId);
        if (background) return agentResult(service, runIds, agentPage(service.read(runId, runIds, false)));
        const unsubscribe = service.subscribe(() => onUpdate?.(result(agentPage(service.read(runId, runIds, false)))));
        try {
          const value = await service.wait(runId, runIds, cancel);
          return agentResult(service, runIds, agentPage(value), value.state !== "completed");
        } finally { unsubscribe(); }
      }
      const cancel = access.signal(signal);
      cancel.throwIfAborted();
      if (input.action === "stop") service.stop(input.runId, runIds);
      const messageStatus = input.action === "steer" ? await service.steer(input.runId, runIds, input.message) : undefined;
      const value = input.action === "wait" ? await service.wait(input.runId, runIds, cancel) : service.read(input.runId, runIds);
      return agentResult(service, runIds, { ...agentPage(value,
        "offset" in input ? input.offset : undefined, "limit" in input ? input.limit : undefined),
        ...(messageStatus ? { messageStatus } : {}) }, ["failed", "cancelled", "interrupted"].includes(value.state));
    },
  });
}

import { Type, validateToolCall } from "@earendil-works/pi-ai";
import { withAbortSignal, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodemodeSandbox, parseCodemodeSource, renderDeclarations, type CodemodeTool } from "@earendil-works/pi-codemode";
import { AssistantError } from "../application/ports.js";
import type { Json } from "../domain/shared.js";
import { json } from "./business-documents.js";

const Runs = defineDocFamily<{ script: string; calls: Record<string, { name: string; arguments: Json; state: string; result: Json }>; state: string }, null>({
  kind: "fire.codemode-run", version: 1, scope: "conversation", family: true, history: "latest", fork: "initial",
  initial: () => ({ script: "", calls: {}, state: "running" }),
});
const Store = defineDoc<{ values: Record<string, Json> }>({ kind: "fire.codemode-store", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ values: {} }) });

/** Keep large records readable after the harness truncates a tool response. */
export function codemodeRecordPage(value: Json, offset = 0, limit = 8000) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000) {
    throw new AssistantError("RUN_WINDOW", "读取窗口为非负 offset 和 1–16000 字符 limit。");
  }
  const text = JSON.stringify(value);
  return { text: text.slice(offset, offset + limit), offset,
    nextOffset: offset + limit < text.length ? offset + limit : null, totalChars: text.length };
}

/** Never replay an entire script. Nested calls use the same guarded tools as direct calls. */
export function codemodeTools(guard: (api: ToolExecutionApi, ctx: Context) => Promise<unknown>): ToolRegistration[] {
  const activeRuns = new Set<string>();
  return [
    defineTool({ name: "codemode", description: "运行 JavaScript，使用 await tools.<name>(args)、text() 和 return。无 Node、文件或网络 API，外部操作仅通过工具。用 describeTool(name) 查参数。调用返回 {content, details, diagnostics, isError}，业务数据通常在 details。副作用不会回滚，脚本不会自动重放。专家委派请直接调用 delegate_expert。",
      parameters: Type.Object({ code: Type.String({ minLength: 1, maxLength: 262144 }) }, { additionalProperties: false }), replay: "unsafe", executionMode: "sequential",
      execute: async ({ code }, api, ctx) => {
        await guard(api, ctx);
        const id = String(api.taskId), parsed = parseCodemodeSource(code);
        await api.commit(async tx => { (await tx.doc(Runs, api.conversationId, id, null)).script = code; }, ctx);
        await api.details({ runId: id }, ctx);
        const agent = await api.agent(ctx);
        const selected = agent.tools.filter(tool => !["codemode", "delegate_expert"].includes(tool.name));
        const pending = new Set<Promise<unknown>>();
        let index = 0;
        const tools: CodemodeTool[] = selected.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as unknown as Record<string, unknown>,
          execute: (input, { signal }) => {
            const callIndex = index++, nested = withAbortSignal(signal, ctx);
            const work = (async () => {
              await guard(api, nested);
              const args = validateToolCall(selected, { type: "toolCall", id: `${api.callId}:${callIndex}`, name: tool.name, arguments: json(input) as Record<string, Json> });
              await api.commit(async tx => {
                (await tx.doc(Runs, api.conversationId, id, null)).calls[callIndex] = { name: tool.name, arguments: json(args), state: "started", result: null };
              }, nested);
              try {
                const result = await tool.execute(args, { ...api, callId: `${api.callId}:${callIndex}` }, nested);
                const value = json({ content: result.content ?? [], details: result.details ?? null,
                  diagnostics: result.diagnostics ?? [], isError: result.isError ?? false });
                await api.commit(async tx => {
                  const call = (await tx.doc(Runs, api.conversationId, id, null)).calls[callIndex]!;
                  call.state = result.isError ? "error" : "completed"; call.result = json(value);
                }, BACKGROUND_CONTEXT);
                if (result.isError) throw new AssistantError("NESTED_TOOL_FAILED", JSON.stringify(value));
                return value;
              } catch (error) {
                await api.commit(async tx => {
                  const call = (await tx.doc(Runs, api.conversationId, id, null)).calls[callIndex]!;
                  if (call.state === "started") { call.state = "interrupted"; call.result = error instanceof Error ? error.message : "工具未完成"; }
                }, BACKGROUND_CONTEXT);
                throw error;
              }
            })();
            pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}); return work;
          },
        }));
        const sandbox = new CodemodeSandbox({ tools, memoryLimitBytes: 256 * 1024 * 1024, globals: [{ name: "describeTool", execute: name => {
          const tool = tools.find(tool => tool.name === name); return tool ? renderDeclarations({ tools: [tool] }) : null;
        } }] });
        activeRuns.add(id);
        try {
          const saved = (await api.snapshot(Store, api.conversationId, ctx))?.values ?? {};
          const result = await sandbox.execute(parsed.code, { store: saved, ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}), ...(parsed.options.timeoutMs ? { timeoutMs: parsed.options.timeoutMs } : {}) });
          await Promise.allSettled([...pending]);
          const incomplete = result.calls.some(call => call.status === "cancelled");
          const completed = result.ok && !incomplete;
          await api.commit(async tx => {
            (await tx.doc(Runs, api.conversationId, id, null)).state = completed ? "completed" :
              incomplete || !result.ok && result.error.kind === "aborted" ? "interrupted" : "failed";
            if (completed) {
              const values = (await tx.doc(Store, api.conversationId)).values;
              for (const key of result.storeWrites.delete) delete values[key];
              for (const [key, value] of Object.entries(result.storeWrites.set)) values[key] = json(value);
            }
          }, BACKGROUND_CONTEXT);
          const output = [...result.output, ...(result.ok && result.value !== undefined ? [{ type: "text" as const, text: JSON.stringify(result.value) }] : []),
            ...(!result.ok ? [{ type: "text" as const, text: result.error.message }] : []),
            ...(incomplete ? [{ type: "text" as const, text: "脚本结束时仍有工具调用未完成。先读取运行记录，不要重放整个脚本。" }] : [])];
          return { content: output, details: { runId: id, completed, incomplete }, isError: !completed };
        } finally {
          try { await sandbox.close(); await Promise.allSettled([...pending]); }
          finally { activeRuns.delete(id); }
        }
      } }),
    defineTool({ name: "read_codemode_run", description: "分页读取本会话 codemode 的脚本和真实嵌套调用记录。offset/limit 以字符计；nextOffset 为 null 时读完。started 表示结果未可靠保存，不代表未执行。",
      parameters: Type.Object({ runId: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }, { additionalProperties: false }), replay: "safe",
      execute: async ({ runId, offset, limit }, api, ctx) => {
        await guard(api, ctx); const run = await api.snapshot(Runs, api.conversationId, runId, ctx);
        if (!run) throw new AssistantError("RUN_MISSING", "没有这次脚本记录。");
        const value = { ...run, ...(run.state === "running" && !activeRuns.has(runId)
          ? { state: "interrupted", recordedState: run.state } : {}) };
        const page = { runId, ...codemodeRecordPage(json(value), offset, limit) };
        return { content: [{ type: "text", text: JSON.stringify(page) }], details: json(page) };
      } }),
  ];
}

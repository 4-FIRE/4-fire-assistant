import type { InitializationTools } from "../application/initialization.js";
import { upsertSource } from "../application/initialization.js";
import type { MemoryPort } from "../application/memory.js";
import type { SetupDraft, SetupSource } from "../domain/workspace.js";
import { AssistantError } from "../application/ports.js";
import { readWorkspace } from "./workspace.js";
import { saveInitialization } from "./complete-initialization.js";
import { parseProposedSource } from "./setup-tools.js";

/** Later changes use the same contracts, but never reset initialization or mutate the live tool snapshot. */
export function sourceConfiguration(directory: string, machineDirectory: string, memory: MemoryPort,
  confirm: (draft: SetupDraft, signal: AbortSignal) => Promise<boolean>, notify: (message: string) => void): Pick<InitializationTools, "proposeSource" | "removeSource"> {
  let tail: Promise<unknown> = Promise.resolve();
  const update = (input: SetupSource | string, signal: AbortSignal) => {
    const selected = typeof input === "string" ? input : parseProposedSource(structuredClone(input) as unknown as Record<string, unknown>);
    const action = async () => {
      signal.throwIfAborted();
      const current = await readWorkspace(directory);
      if (current.initialization !== "complete") throw new AssistantError("INITIALIZATION_REQUIRED", "请先完成初始化。");
      if (typeof selected === "string" && !current.draft.sources.some(item => item.id === selected)) throw new AssistantError("SOURCE_MISSING", "没有这个来源标识。");
      const draft = typeof selected === "string" ? { sources: current.draft.sources.filter(item => item.id !== selected) } : upsertSource(current.draft, selected);
      if (!await confirm(structuredClone(draft), signal)) throw new AssistantError("SOURCE_CHANGE_DECLINED", "用户取消了此次接入修改，不要自动重试。");
      signal.throwIfAborted();
      await memory.record("connection:" + JSON.stringify(draft), "# 用户已确认的接入请求\n\n此记忆记录确认，不证明配置已成功保存；连接与权限以启动时核实的实际配置为准。\n\n" + JSON.stringify(draft, null, 2));
      signal.throwIfAborted();
      await saveInitialization(directory, machineDirectory, { ...current, draft });
      notify("接入变更已保存；请重启加载新连接和权限。当前运行继续使用原启动快照。");
      return { ...structuredClone(draft), restartRequired: true };
    };
    const result = tail.then(action); tail = result.catch(() => {}); return result;
  };
  return { proposeSource: (source, signal) => update(source, signal), removeSource: (id, signal) => update(id, signal) };
}

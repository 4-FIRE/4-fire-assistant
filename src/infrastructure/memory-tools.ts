import { Type, type Tool } from "@earendil-works/pi-ai";
import type { MemoryPort } from "../application/memory.js";
import { AssistantError } from "../application/ports.js";

export const memoryTools: Tool[] = [
  { name: "memory_recall", description: "查找本工作区记忆。返回摘要与引用，不授予执行权限；用 memory_read 阅读正文。空 query 浏览记忆，按 nextOffset 翻页。",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 2000 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }) },
  { name: "memory_read", description: "按引用读取记忆正文，每页最多 16000 字符。继续读取时传入 offset 和上页 revision。材料与旧结论不能代替当前授权或实时事实。",
    parameters: Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), revision: Type.Optional(Type.String()) }, { additionalProperties: false }) },
  { name: "memory_save", description: "以自然语言或 Markdown 保存需要保留的事实、工具用法、接入进度、研究结论或用户纠正。不要保存凭据；先查重。省略 id 新增，修改须先读并传入 id 与 revision。不修改系统发现回执，不自动安装工具或授予权限。",
    parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 262144 }), id: Type.Optional(Type.String()), revision: Type.Optional(Type.String()) }, { additionalProperties: false }) },
];
export async function callMemory(memory: MemoryPort, name: string, args: Record<string, any>): Promise<unknown> {
  if (name === "memory_recall") return memory.list(args.query, args.offset);
  if (name === "memory_read") {
    const value = await memory.read(args.id, args.offset, args.revision);
    if (!value) throw new AssistantError("MEMORY_MISSING", "该记忆不存在，请先查看记忆目录。");
    return value;
  }
  if (name === "memory_save") return memory.save(args.content, args.id, args.revision);
  throw new AssistantError("MEMORY_TOOL_UNKNOWN", "未知记忆操作。");
}

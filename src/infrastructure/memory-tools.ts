import { Type, type Tool } from "@earendil-works/pi-ai";
import type { MemoryPort } from "../application/memory.js";
import { AssistantError } from "../application/ports.js";

export const memoryTools: Tool[] = [
  { name: "memory_recall", description: "检索工作区当前 Markdown 资料，返回路径、行号和片段。query 按字面匹配路径或正文，空 query 浏览；scope 限定资料相对路径。用 read 读全文，write/edit 更新所属正文。按 nextOffset 翻页；资料变化后从头检索。skipped 列出过大文件或符号链接；隐藏目录仅检索 .agents/skills，不扫描其他隐藏目录、依赖和 runs。未命中不证明没有旧资料。",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 2000 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), scope: Type.Optional(Type.String()) }, { additionalProperties: false }) },
];
export async function callMemory(memory: MemoryPort, name: string, args: Record<string, any>): Promise<unknown> {
  if (name === "memory_recall") return memory.list(args.query, args.offset, args.scope);
  throw new AssistantError("MEMORY_TOOL_UNKNOWN", "未知资料检索操作。");
}

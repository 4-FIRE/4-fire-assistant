import { Type, type Tool } from "@earendil-works/pi-ai";
import type { InitializationTools } from "../application/initialization.js";
import { AssistantError } from "../application/ports.js";
import { parseSetupDraft } from "./workspace.js";

export const setupTools: Tool[] = [
  { name: "locate_cli", description: "按单独命令名查找本机 PATH，返回路径；不执行程序。", parameters: Type.Object({ command: Type.String({ minLength: 1 }) }, { additionalProperties: false }) },
  { name: "inspect_source", description: "取得 CLI 帮助或 MCP 工具清单供阅读，执行前单独确认。只需必要连接材料，不先填用途或缺口。默认复用记忆；明确重新核实时 refresh=true，保留旧版本；不安装、不授予业务权限。",
    parameters: Type.Object({ source: Type.Object({ name: Type.String({ minLength: 1 }), kind: Type.Union([Type.Literal("mcp"), Type.Literal("cli")]),
      description: Type.Optional(Type.String()), missing: Type.Optional(Type.Array(Type.String())),
      location: Type.Optional(Type.String()), connection: Type.Optional(Type.Record(Type.String(), Type.Unknown())), discoveryArgs: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false }), refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) },
  { name: "read_material", description: "有界读取用户提供的本地文档绝对路径，先确认。不是任意文件搜索，不读取凭据；返回 nextOffset 时可继续阅读。",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }) },
  { name: "install_mcp", description: "依据已阅读的可信安装说明提出 MCP 的精确安装命令。仅支持明确的包安装器，无 shell、sudo 或任意脚本执行。执行前单独确认；安装回执作为记忆，不等于接入或权限就绪。默认复用历史回执，远端或已安装服务不需重复安装。只有新的明确重装请求可 repeat=true，仍须确认；失败后先核对。",
    parameters: Type.Object({ name: Type.String({ minLength: 1 }), command: Type.String(), args: Type.Array(Type.String(), { maxItems: 256 }), repeat: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) },
  { name: "propose_source", description: "依据已读文档显式提交或更新一个来源的可执行接入约定。先读 references/tool-connections.md。不是普通回答的必经步骤；不会替换其他来源，不能自动授予权限。用途、缺口、未完成的说明放入记忆。",
    parameters: Type.Object({ source: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }) },
  { name: "remove_source", description: "用户明确要求移除来源时，按稳定 id 提出删除该来源。不能因本轮未讨论它而删除；生效仍须用户确认。",
    parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }) },
];
const methods = { locate_cli: "locateCli", inspect_source: "inspect", read_material: "readDocument", install_mcp: "installMcp", propose_source: "proposeSource", remove_source: "removeSource" } as const;
export function availableSetupTools(ports: InitializationTools): Tool[] { return setupTools.filter(tool => !!ports[methods[tool.name as keyof typeof methods]]); }
export function parseProposedSource(value: Record<string, unknown>) {
  const source = parseSetupDraft({ sources: [{ description: "", location: "", missing: [], ...value }] }).sources[0]!;
  if (!source.id || !source.connection || !source.operations?.length) throw new AssistantError("SOURCE_CONTRACT_INCOMPLETE", "接入需要稳定 id、连接和操作约定；未完成的材料请保存为记忆，继续阅读或说明缺口。");
  if (source.kind === "cli" && source.operations.some(op => !Array.isArray(op.argv))) throw new AssistantError("CLI_BINDING_REQUIRED", "CLI 操作需要明确 argv 绑定，不能猜测调用格式。");
  return source;
}
export async function callSetup(ports: InitializationTools, name: string, args: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (name === "locate_cli" && ports.locateCli) return { command: args.command, path: await ports.locateCli(args.command, signal) };
  if (name === "inspect_source" && ports.inspect) {
    const source = parseSetupDraft({ sources: [{ description: "", location: "", missing: [], ...args.source }] }).sources[0]!;
    return { source, material: await ports.inspect(source, signal, args.refresh) };
  }
  if (name === "read_material" && ports.readDocument) return ports.readDocument(args.path, signal, args.offset);
  if (name === "install_mcp" && ports.installMcp) return { receipt: await ports.installMcp({ name: args.name, command: args.command, args: args.args, repeat: args.repeat }, signal) };
  if (name === "propose_source" && ports.proposeSource) return ports.proposeSource(parseProposedSource(args.source), signal);
  if (name === "remove_source" && ports.removeSource) return ports.removeSource(args.id, signal);
  throw new AssistantError("SETUP_TOOL_UNAVAILABLE", "当前没有该接入能力；请分析已有材料或说明缺口。");
}

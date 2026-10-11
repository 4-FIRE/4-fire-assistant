import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { AssistantError } from "../application/ports.js";
import type { WorkspaceServices, ConfirmAction } from "./workspace-services.js";
import { discoverSource, installPackage, locateCli } from "./source-discovery.js";
import { parseSourceConnection } from "./integrations/connection-config.js";
import { result } from "./tool-result.js";

const native = Type.Record(Type.String(), Type.Unknown());
const sourceId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$", description: "来源 id：以小写字母开头，只含小写字母、数字和连字符，长度 1–64；不能用下划线。" });
export function setupTools(services: WorkspaceServices, confirm: ConfirmAction): ToolRegistration[] {
  return [
    defineTool({ name: "locate_cli", description: "查找 PATH 中的命令，不执行。", parameters: Type.Object({ command: Type.String() }), replay: "safe",
      execute: async ({ command }) => result({ path: await locateCli(command) }) }),
    defineTool({ name: "inspect_source", description: "经用户确认读取 MCP 工具清单或 CLI 帮助。原生入口来自用户资料。发现不授予业务权限。",
      parameters: Type.Object({ connection: native, args: Type.Optional(Type.Array(Type.String(), { maxItems: 256 })) }, { additionalProperties: false }), replay: "unsafe",
      execute: async ({ connection, args }, _api, ctx) => {
        const checked = parseSourceConnection(connection), argv = args ?? ["--help"];
        if (!await confirm("查询服务接口。请确认外部程序可信。即使是帮助命令，也可能修改数据或执行其他操作。", JSON.stringify({ connection: checked, args: argv }, null, 2), ctx.abortSignal)) throw new AssistantError("DISCOVERY_DECLINED", "用户取消接口发现。");
        return result(await discoverSource(checked, argv, services.root, ctx.abortSignal));
      } }),
    defineTool({ name: "install_package", description: "按已阅读的可信说明安装本地 CLI/MCP 包。仅支持 npm/pip/uv/python -m pip 安装，执行前确认。远端或已有软件不要重复安装；失败可能留下文件。",
      parameters: Type.Object({ command: Type.String(), args: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }) }, { additionalProperties: false }), replay: "unsafe",
      execute: async ({ command, args }, _api, ctx) => {
        if (!await confirm("安装本机软件。此确认不授予服务接入权限或交易许可。", JSON.stringify({ command, args, directory: services.directory + "/packages" }, null, 2), ctx.abortSignal)) throw new AssistantError("INSTALL_DECLINED", "用户取消安装。");
        return result(await installPackage(command, args, services.directory, ctx.abortSignal));
      } }),
    defineTool({ name: "configure_source", description: "确认并连接或修复一个 CLI/MCP 来源，立即可用于验证。保留原生参数，无统一行情接口。先读服务接入技能。手册用 write/edit 保存到 sources/<id>/GUIDE.md，索引用 sources/AGENTS.md。",
      parameters: Type.Object({ id: sourceId, connection: native, operations: Type.Array(native, { minItems: 1 }) }, { additionalProperties: false }), replay: "unsafe", executionMode: "sequential",
      execute: async ({ id, connection, operations }, _api, ctx) => result(await services.configure(id, { connection, operations }, ctx.abortSignal)) }),
    defineTool({ name: "remove_source", description: "用户要求撤回时移除一个来源，执行前确认。保留手册、研究、交易记录和已完成初始化状态。",
      parameters: Type.Object({ id: sourceId }, { additionalProperties: false }), replay: "unsafe", executionMode: "sequential",
      execute: async ({ id }, _api, ctx) => result(await services.remove(id, ctx.abortSignal)) }),
  ];
}

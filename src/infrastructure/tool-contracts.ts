import type { ToolPort, DispatchPermit } from "../application/business-ports.js";
import { AssistantError } from "../application/ports.js";
import { object, type OperationSpec, type Scope, type Parameters } from "../domain/shared.js";
import { CliTools } from "./integrations/cli-tools.js";
import { parseCliBinding, type CliBinding } from "./integrations/cli-contract.js";
import { parseOperationContract, type OperationContract } from "./integrations/operation-contract.js";
import type { SourceConnection } from "./integrations/connection-config.js";
import { McpConnection } from "./integrations/mcp-connection.js";
import { McpTools } from "./integrations/mcp-tools.js";
import { classifyWrite } from "./integrations/write-result.js";
import { compileToolSchema } from "./integrations/tool-schema.js";

export interface ToolContract {
  version: 1;
  sourceId: string;
  operations: (OperationContract & Partial<CliBinding> & { roles: string[] })[];
}
export function parseToolContract(value: unknown): ToolContract {
  if (!object(value) || value.version !== 1 || typeof value.sourceId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.sourceId) ||
      !Array.isArray(value.operations) || Object.keys(value).some(k => !["version", "sourceId", "operations"].includes(k))) invalid();
  const names = new Set<string>();
  const operations = value.operations.map(item => {
    if (!object(item) || !Array.isArray(item.roles) || !item.roles.length || !item.roles.every(role => typeof role === "string" && /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(role))) invalid();
    const { roles, argv, stdin, ...native } = item;
    const checked = parseOperationContract(native);
    if (names.has(checked.name)) invalid(); names.add(checked.name);
    const binding = parseCliBinding({ argv, stdin }, checked.schema);
    return { ...checked, ...binding, roles: [...new Set(roles)] as string[] };
  });
  return { version: 1, sourceId: value.sourceId, operations };
}
function invalid(): never { throw new AssistantError("INVALID_TOOL_CONTRACT", "来源约定无效；需要操作身份、权限，以及 CLI 的原生参数绑定。"); }

/** Permission wrapper; read data stays opaque and MCP schemas come from the service. */
export class ContractTools implements ToolPort {
  constructor(private readonly source: ToolPort, private readonly contract: ToolContract) {}
  allowed(name: string, role: string): boolean { return this.contract.operations.find(op => op.name === name)?.roles.includes(role) ?? false; }
  status() { return this.source.status(); }
  catalog() {
    return this.source.catalog().flatMap(item => {
      const op = this.contract.operations.find(op => op.name === item.name);
      return op ? [{ ...item, kind: op.access, ...(op.execution ? { execution: op.execution } : {}) }] : [];
    });
  }
  kind(name: string) { return this.contract.operations.find(op => op.name === name)?.access; }
  requirements(name: string) {
    if (this.kind(name) !== "write") throw new AssistantError("OPERATION_DENIED", "这不是交易写入操作。");
    return { reviewRequired: true, confirmationRequired: true as const };
  }
  binding(name: string) {
    if (!this.kind(name)) throw new AssistantError("OPERATION_DENIED", "操作未获授权。");
    return this.source.binding(name);
  }
  preview(operation: OperationSpec) { return this.source.preview?.(operation) ?? operation as unknown as Parameters; }
  refresh(signal?: AbortSignal) { return this.source.refresh(signal); }
  validate(operation: OperationSpec) { this.binding(operation.name); this.source.validate(operation); }
  async read(operation: OperationSpec, signal?: AbortSignal) {
    if (this.kind(operation.name) !== "read") throw new AssistantError("OPERATION_DENIED", "查询入口不能执行交易写入。");
    await this.refresh(signal); this.validate(operation);
    return this.source.read(operation, signal);
  }
  async dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal) {
    const contract = this.contract.operations.find(op => op.name === operation.name);
    if (contract?.access !== "write" || !contract.outcomes) throw new AssistantError("WRITE_CONTRACT_REQUIRED", "缺少交易回执约定。");
    const result = await this.source.dispatch(permit, operation, scope, signal);
    if (result.outcome !== undefined) return result;
    return classifyWrite(result, compileToolSchema(contract.outcomes.accepted), compileToolSchema(contract.outcomes.rejected));
  }
}
export async function openSource(connection: SourceConnection, contract: ToolContract, cwd: string, signal?: AbortSignal) {
  if (connection.transport === "cli") {
    const { transport: _transport, ...config } = connection;
    const source = await CliTools.open({ ...config, operations: contract.operations.map(({ roles: _roles, ...op }) => {
      if (!op.argv || !op.schema) invalid();
      return { ...op, argv: op.argv, schema: op.schema };
    }) }, cwd);
    return { tools: new ContractTools(source, contract), close: async () => {} };
  }
  const client = await McpConnection.connect(connection, { cwd, inheritEnv: false, ...(signal ? { signal } : {}) });
  try {
    for (const op of contract.operations) if (!client.catalog().some(tool => tool.name === op.name)) invalid();
    const source = new McpTools(client, Object.fromEntries(contract.operations.map(op => [op.name, op.access])));
    return { tools: new ContractTools(source, contract), close: () => client.close() };
  } catch (error) { await client.close(); throw error; }
}

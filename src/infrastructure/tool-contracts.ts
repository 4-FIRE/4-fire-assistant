import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { AssistantError } from "../application/ports.js";
import type { ToolPort, DispatchPermit } from "../application/business-ports.js";
import { object, type Parameters, type Role, type OperationSpec, type Scope } from "../domain/shared.js";
import { CliTools, parseCliConfig, type CliConfig, type CliOperation } from "./integrations/cli-tools.js";
import { McpConnection, digest, type ConnectionConfig } from "./integrations/mcp.js";
import { McpTools } from "./integrations/mcp-tools.js";
import { classifyWrite } from "./integrations/write-result.js";
import { compileToolSchema } from "./integrations/schema.js";
import { ToolSources } from "./integrations/tool-sources.js";

export type SourceConnection = ConnectionConfig | ({ transport: "cli" } & Omit<CliConfig, "operations">);
export interface ToolContract {
  version: 1;
  sourceId: string;
  operations: (Omit<CliOperation, "argv"> & { argv?: CliOperation["argv"]; roles: string[] })[];
}
export function parseToolContract(value: unknown): ToolContract {
  if (!object(value) || value.version !== 1 || typeof value.sourceId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.sourceId) ||
      !Array.isArray(value.operations) || Object.keys(value).some(k => !["version", "sourceId", "operations"].includes(k))) invalid();
  const names = new Set<string>();
  const operations = value.operations.map(item => {
    if (!object(item) || !Array.isArray(item.roles) || !item.roles.length || !item.roles.every(role => typeof role === "string" && /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(role))) invalid();
    const { roles, ...native } = item;
    // Reuse input/schema validation. MCP has no CLI binding; the synthetic token is not persisted.
    const checked = parseCliConfig({ command: "/contract-validation", operations: [{ ...native, argv: native.argv ?? (native.stdin === "json" ? [] : [{ parameters: "json" }]) }] }).operations[0]!;
    if (names.has(checked.name)) invalid(); names.add(checked.name);
    const { argv, ...rest } = checked;
    return { ...rest, roles: [...new Set(roles)] as string[], ...(native.argv === undefined ? {} : { argv }) };
  });
  return { version: 1, sourceId: value.sourceId, operations };
}
function invalid(): never { throw new AssistantError("INVALID_TOOL_CONTRACT", "来源约定无效；需要明确的操作、输入 schema、执行要求和角色授权。"); }

export class ContractTools implements ToolPort {
  #ready = true;
  readonly #roles: Map<string, Set<string>>;
  readonly #results = new Map<string, ValidateFunction>();
  private readonly contract: ToolContract;
  constructor(private readonly source: ToolPort, input: ToolContract) {
    const contract = structuredClone(input); this.contract = contract;
    this.#roles = new Map(contract.operations.map(op => [op.name, new Set(op.roles)]));
    for (const operation of contract.operations) if (operation.resultSchema) {
      this.#results.set(operation.name, compileToolSchema(operation.resultSchema));
    }
    this.checkCatalog();
  }
  private checkCatalog(): void {
    for (const operation of this.contract.operations) {
      const actual = this.source.catalog().find(item => item.name === operation.name);
      if (!actual || digest(actual.schema) !== digest(operation.schema) || actual.description !== operation.description) {
        this.#ready = false;
        throw new AssistantError("TOOL_CONTRACT_CHANGED", "来源接口与已确认约定不符，来源已停用；请重新核对。");
      }
    }
  }
  allowed(name: string, role: Role): boolean { return this.#ready && !!this.#roles.get(name)?.has(role); }
  status() { return { ready: this.#ready, detail: this.source.status() }; }
  catalog() { return this.#ready ? this.source.catalog().filter(item => this.#roles.has(item.name)).map(item => {
    const operation = this.contract.operations.find(op => op.name === item.name)!;
    return { ...item, kind: operation.access, ...(operation.execution ? { execution: operation.execution } : {}),
      ...(operation.argv ? { invocation: { argv: operation.argv, ...(operation.stdin ? { stdin: operation.stdin } : {}) } } : {}),
      ...(operation.resultSchema ? { resultSchema: operation.resultSchema } : {}) };
  }) : []; }
  kind(name: string) { return this.#ready ? this.contract.operations.find(op => op.name === name)?.access : undefined; }
  requirements(name: string) {
    const execution = this.contract.operations.find(op => op.name === name)?.execution;
    if (!execution) throw new AssistantError("WRITE_CONTRACT_REQUIRED", "操作没有已确认的写入要求。");
    return structuredClone(execution);
  }
  binding(name: string) {
    if (!this.kind(name)) throw new AssistantError("OPERATION_DENIED", "操作未获得工作区授权。");
    return { ...this.source.binding(name), accessDigest: digest(this.contract as unknown as Parameters) };
  }
  async refresh(signal?: AbortSignal) {
    if (!this.#ready) throw new AssistantError("TOOL_CONTRACT_CHANGED", "来源已经停用；重新核对后再启动。");
    try { await this.source.refresh(signal); this.checkCatalog(); }
    catch (error) { this.#ready = false; throw error; }
  }
  validate(operation: OperationSpec) { this.binding(operation.name); this.source.validate(operation); }
  async read(operation: { name: string; parameters: Parameters }, signal?: AbortSignal) {
    if (this.kind(operation.name) !== "read") throw new AssistantError("OPERATION_DENIED", "只读入口不能执行写入。");
    this.binding(operation.name); await this.refresh(signal); this.source.validate(operation);
    const result = await this.source.read(operation, signal);
    const validate = this.#results.get(operation.name);
    return { ...result, success: result.success && (!validate || !!validate(result.data)) };
  }
  async dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal) {
    const exact = structuredClone(operation);
    const contract = this.contract.operations.find(op => op.name === exact.name);
    if (!contract?.outcomes || contract.access !== "write") throw new AssistantError("WRITE_CONTRACT_REQUIRED", "缺少写入结果约定。");
    try { await this.refresh(signal); this.validate(exact); }
    catch { throw new AssistantError("PROVEN_NOT_SENT", "来源检查失败；未发送。"); }
    const result = await this.source.dispatch({ consume: (_binding, actual, actualScope) =>
      permit.consume(this.binding(actual.name), actual, actualScope) }, exact, scope, signal);
    if (result.outcome === "unknown") return result;
    return classifyWrite(result, compileToolSchema(contract.outcomes.accepted), compileToolSchema(contract.outcomes.rejected));
  }
}

export async function openToolSources(directory: string, connections: Record<string, SourceConnection>, cwd: string, enabled?: readonly string[]) {
  const sources = new Map<string, ToolPort>();
  const opened: McpConnection[] = [];
  const notices: string[] = [];
  let files: string[];
  try { files = await readdir(join(directory, "tools")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files = []; else throw error; }
  for (const file of files.filter(file => /^[a-z][a-z0-9-]{0,63}\.json$/.test(file)).sort()) {
    const id = file.slice(0, -5);
    if (enabled && !enabled.includes(id)) continue;
    try {
      const contract = parseToolContract(JSON.parse(await readFile(join(directory, "tools", file), "utf8")));
      if (contract.sourceId !== id) invalid();
      const connection = Object.hasOwn(connections, id) ? connections[id] : undefined;
      if (!connection) throw new AssistantError("SOURCE_CONNECTION_MISSING", "本机没有该来源的连接材料。");
      let source: ToolPort;
      if (connection.transport === "cli") {
        const { transport: _transport, ...settings } = connection;
        source = await CliTools.open({ ...settings, operations: contract.operations.map(({ roles: _roles, ...op }) => {
          if (!op.argv) invalid(); return { ...op, argv: op.argv };
        }) }, cwd);
      } else {
        const mcp = await McpConnection.connect(connection, { cwd, inheritEnv: false });
        opened.push(mcp);
        source = new McpTools(mcp, Object.fromEntries(contract.operations.map(op => [op.name, op.access])));
      }
      sources.set(id, new ContractTools(source, contract));
    } catch (error) {
      notices.push(`${id}: ${error instanceof AssistantError ? error.code : "SOURCE_LOAD_FAILED"}；该来源未启用。`);
    }
  }
  return { tools: new ToolSources(sources), notices,
    async close() { await Promise.allSettled(opened.map(connection => connection.close())); } };
}

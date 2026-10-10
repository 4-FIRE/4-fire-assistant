import type { DispatchPermit, NativeObservation, ToolAccess, ToolKind, ToolPort } from "../../application/business-ports.js";
import { AssistantError } from "../../application/ports.js";
import type { Json, OperationSpec, Scope, ServiceBinding } from "../../domain/shared.js";
import { McpConnection, digest, payload } from "./mcp.js";

/** Service-independent MCP calls. Business data stays opaque. */
export class McpTools implements ToolPort {
  readonly #access: ToolAccess;
  readonly #accessDigest: string;
  constructor(private readonly connection: McpConnection, access: ToolAccess) {
    this.#access = structuredClone(access);
    this.#accessDigest = digest(this.#access);
    connection.restrictTools(this.#access);
  }
  kind(name: string): ToolKind | undefined { return Object.hasOwn(this.#access, name) ? this.#access[name] : undefined; }
  catalog() { return this.connection.catalog().map(tool => ({ ...tool, ...(this.kind(tool.name) ? { kind: this.kind(tool.name)! } : {}) })); }
  status() {
    return { connected: this.connection.connected, connectionId: this.connection.identity, epoch: this.connection.epoch,
      accessDigest: this.#accessDigest, schemaReady: this.connection.schemaReady, unavailableSchemas: [...this.connection.unavailableSchemas] };
  }
  binding(name: string): ServiceBinding {
    const tool = this.catalog().find(tool => tool.name === name);
    if (!tool || !this.kind(name) || !this.connection.connected) throw new AssistantError("OPERATION_UNAVAILABLE", "操作未分类或当前服务未提供可靠 schema。");
    return { connectionId: this.connection.identity, epoch: this.connection.epoch, accessDigest: this.#accessDigest, schemaDigest: tool.schemaDigest };
  }
  refresh(signal?: AbortSignal): Promise<void> { return this.connection.refresh(signal); }
  validate(operation: OperationSpec): void {
    this.binding(operation.name);
    this.connection.validate(operation.name, operation.parameters);
  }
  async read(operation: OperationSpec, signal?: AbortSignal): Promise<NativeObservation> {
    if (this.kind(operation.name) !== "read") throw new AssistantError("OPERATION_DENIED", "只读入口仅接受本地分类为 read 的工具。");
    this.validate(operation);
    const result = await this.connection.call(operation.name, operation.parameters, signal);
    return { success: result.isError !== true, raw: JSON.parse(JSON.stringify(result)) as Json, data: payload(result) };
  }
  async dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal): Promise<NativeObservation> {
    if (this.kind(operation.name) !== "write") throw new AssistantError("OPERATION_DENIED", "操作未分类为受控写入。");
    const result = await this.connection.transmitOnce(operation.name, operation.parameters,
      () => permit.consume(this.binding(operation.name), operation, scope), signal);
    return { success: result.isError !== true, raw: JSON.parse(JSON.stringify(result)) as Json, data: payload(result) };
  }
}

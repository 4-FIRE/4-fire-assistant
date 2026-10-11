import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { digest, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { Source, Operation } from "../model/source.js";
import type { SourceAccess } from "../services/source-access.js";
import { environment, expand } from "./source-environment.js";
import { PrivateMcp } from "./private-mcp.js";
import { invokeCli } from "./cli-source.js";

export class SourceConnections implements SourceAccess {
  readonly #epochs = new Map<string, string>();
  readonly #private: PrivateMcp;
  #closed = false;
  constructor(private readonly root: string) {
    this.#private = new PrivateMcp(root, source => this.credentials(source), id => this.#epochs.set(id, randomUUID()));
  }
  private epoch(id: string) {
    if (!this.#epochs.has(id)) this.#epochs.set(id, randomUUID());
    return this.#epochs.get(id)!;
  }
  private credentials(source: Source) {
    return digest({ env: environment(source), headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  async replace(source: Source) {
    requireThat(!this.#closed, "来源已关闭。");
    if (source.command) { await access(source.command, constants.X_OK); source.command = await realpath(source.command); }
    await this.#private.remove(source.id); this.#epochs.delete(source.id);
  }
  async discover(source: Source, signal?: AbortSignal) {
    requireThat(!this.#closed && source.kind === "mcp", "仅 MCP 支持工具协议发现。");
    return this.#private.discover(source, signal);
  }
  async binding(source: Source, operation: Operation, signal?: AbortSignal): Promise<string> {
    requireThat(!this.#closed, "来源已关闭。");
    if (source.kind === "cli") await access(source.command!, constants.X_OK);
    return this.identity(source, source.kind === "cli" ? operation.inputSchema : await this.#private.definition(source, operation.name, signal));
  }
  identity(source: Source, native: unknown) {
    return digest({ source: { ...source, operations: source.operations.map(operation => ({ ...operation })) }, native,
      epoch: this.epoch(source.id), environment: environment(source),
      headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  async invoke(source: Source, operation: Operation, parameters: Params, preview: Params, gate: (native: unknown) => void,
    signal?: AbortSignal, write = false) {
    signal?.throwIfAborted(); requireThat(!this.#closed, "来源已关闭。");
    if (source.kind === "cli") return invokeCli(this.root, source, operation, parameters, preview, gate, signal);
    return this.#private.invoke(source, operation.name, parameters, gate, signal, write);
  }
  async close() { this.#closed = true; await this.#private.close(); }
}

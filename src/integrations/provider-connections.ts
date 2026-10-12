import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { digest, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { Provider, Operation } from "../model/provider.js";
import type { ProviderAccess } from "../services/provider-access.js";
import { environment, expand } from "./provider-environment.js";
import { PrivateMcp } from "./private-mcp.js";
import { invokeCli } from "./cli-provider.js";

export class ProviderConnections implements ProviderAccess {
  readonly #epochs = new Map<string, string>();
  readonly #private: PrivateMcp;
  #closed = false;
  constructor(private readonly root: string) {
    this.#private = new PrivateMcp(root, provider => this.credentials(provider), id => this.#epochs.set(id, randomUUID()));
  }
  private epoch(id: string) {
    if (!this.#epochs.has(id)) this.#epochs.set(id, randomUUID());
    return this.#epochs.get(id)!;
  }
  private credentials(provider: Provider) {
    return digest({ env: environment(provider), headers: Object.fromEntries(Object.entries(provider.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  async replace(provider: Provider) {
    requireThat(!this.#closed, "能力提供方已关闭。");
    if (provider.command) { await access(provider.command, constants.X_OK); provider.command = await realpath(provider.command); }
    await this.#private.remove(provider.id); this.#epochs.delete(provider.id);
  }
  async discover(provider: Provider, signal?: AbortSignal, refresh = true) {
    requireThat(!this.#closed && provider.kind === "mcp", "仅 MCP 支持工具协议发现。");
    return this.#private.discover(provider, signal, refresh);
  }
  async binding(provider: Provider, operation: Operation, signal?: AbortSignal): Promise<string> {
    requireThat(!this.#closed, "能力提供方已关闭。");
    if (provider.kind === "cli") await access(provider.command!, constants.X_OK);
    return this.identity(provider, provider.kind === "cli" ? operation.inputSchema : await this.#private.definition(provider, operation.name, signal));
  }
  identity(provider: Provider, native: unknown) {
    return digest({ provider: { ...provider, operations: provider.operations.map(operation => ({ ...operation })) }, native,
      epoch: this.epoch(provider.id), environment: environment(provider),
      headers: Object.fromEntries(Object.entries(provider.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  async invoke(provider: Provider, operation: Operation, parameters: Params, preview: Params, gate: (native: unknown) => void,
    signal?: AbortSignal) {
    signal?.throwIfAborted(); requireThat(!this.#closed, "能力提供方已关闭。");
    if (provider.kind === "cli") return invokeCli(this.root, provider, operation, parameters, preview, gate, signal);
    return this.#private.invoke(provider, operation.name, parameters, gate, signal);
  }
  async close() { this.#closed = true; await this.#private.close(); }
}

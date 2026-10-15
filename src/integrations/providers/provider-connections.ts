import { randomUUID } from "node:crypto";
import { digest, type Params } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import type { Provider, Operation } from "../../model/provider.js";
import type { ProviderAccess } from "../../services/providers/provider-access.js";
import { environment, expand } from "./provider-environment.js";
import { PrivateMcp } from "./private-mcp.js";
import { CliProvider } from "./cli-provider.js";
import type { ProviderCallStrategy } from "./provider-call-strategy.js";

export class ProviderConnections implements ProviderAccess {
  readonly #epochs = new Map<string, string>();
  readonly #private: PrivateMcp;
  readonly #strategies: Record<Provider["kind"], ProviderCallStrategy>;
  #closed = false;
  constructor(root: string) {
    this.#private = new PrivateMcp(root, provider => this.credentials(provider), id => this.#epochs.set(id, randomUUID()));
    this.#strategies = { cli: new CliProvider(root), mcp: this.#private };
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
    await this.#strategies[provider.kind].prepare(provider);
    await this.#private.remove(provider.id);
    this.#epochs.delete(provider.id);
  }
  async discover(provider: Provider, signal?: AbortSignal, refresh = true) {
    requireThat(!this.#closed && provider.kind === "mcp", "仅 MCP 支持工具协议发现。");
    return this.#private.discover(provider, signal, refresh);
  }
  async binding(provider: Provider, operation: Operation, signal?: AbortSignal): Promise<string> {
    requireThat(!this.#closed, "能力提供方已关闭。");
    const native = await this.#strategies[provider.kind].definition(provider, operation, signal);
    return this.identity(provider, native);
  }
  preview(provider: Provider, operation: Operation, parameters: Params) {
    requireThat(!this.#closed, "能力提供方已关闭。");
    return this.#strategies[provider.kind].preview(provider, operation, parameters);
  }
  identity(provider: Provider, native: Params) {
    return digest({ provider: { ...provider, operations: provider.operations.map(operation => ({ ...operation })) }, native,
      epoch: this.epoch(provider.id), environment: this.#strategies[provider.kind].environment(provider),
      headers: Object.fromEntries(Object.entries(provider.headers ?? {}).map(([k, v]) => [k, expand(v)])) });
  }
  async invoke(provider: Provider, operation: Operation, parameters: Params, gate: (native: Params) => void,
    signal?: AbortSignal) {
    signal?.throwIfAborted();
    requireThat(!this.#closed, "能力提供方已关闭。");
    return this.#strategies[provider.kind].invoke(provider, operation, parameters, gate, signal);
  }
  async close() {
    this.#closed = true;
    await this.#private.close();
  }
}

import { randomUUID } from "node:crypto";
import { canonical, type Json, type Params } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import type { Intent, Scope } from "../../model/execution-intent.js";
import type { Observation } from "../../model/receipt.js";
import type { Operation } from "../../model/provider.js";
import type { Store } from "../../storage/store.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { Ledger } from "./execution-ledger.js";

type CallResponse = Intent & { data?: Json; dataPath?: string };

export class ExecutionService {
  private readonly ledger: Ledger;
  readonly #active = new Set<Promise<Intent>>();
  #closed = false;
  #healthy = true;
  constructor(private readonly providers: ProviderRegistry, private readonly store: Pick<Store, "calls" | "healthy">) {
    this.ledger = new Ledger(store.calls);
    this.ledger.recover();
  }
  get(id: string) { return this.ledger.get(id); }
  unknownCalls() { return this.ledger.unknownCalls(); }
  call(scope: Scope, provider: string, operation: string, parameters: Params,
    confirm: (preview: unknown, recheck: () => Promise<void>) => Promise<boolean> = async () => false, signal?: AbortSignal): Promise<CallResponse> {
    const pending = this.invoke(scope, provider, operation, structuredClone(parameters), confirm, signal);
    this.#active.add(pending);
    void pending.finally(() => this.#active.delete(pending)).catch(() => undefined);
    return pending;
  }
  private check(signal?: AbortSignal) {
    signal?.throwIfAborted();
    requireThat(!this.#closed && this.#healthy && this.store.healthy, "调用写入不可用；请核对记录。");
  }
  private async invoke(scope: Scope, provider: string, operation: string, parameters: Params,
    confirm: (preview: unknown, recheck: () => Promise<void>) => Promise<boolean>, signal?: AbortSignal): Promise<CallResponse> {
    this.check(signal);
    requireThat(this.providers.permission(provider, operation) !== "deny", "工具被禁止。");
    const binding = await this.providers.binding(provider, operation, signal);
    const preview = this.providers.preview(provider, operation, parameters);
    const permissions = canonical(this.providers.permissions.read());
    const permission = this.providers.permission(provider, operation);
    requireThat(permission !== "deny", "工具被禁止。");
    this.check(signal);
    const intent = this.ledger.create(scope, provider, operation, parameters, binding, permission);
    let entered = false;
    try {
      const recheck = async () => {
        this.check(signal);
        requireThat(canonical(this.providers.permissions.read()) === permissions, "批准等待期间工具权限已变化。");
        requireThat(await this.providers.binding(provider, operation, signal) === binding, "批准等待期间连接或目录已变化。");
        requireThat(canonical(this.providers.preview(provider, operation, parameters)) === canonical(preview), "批准等待期间调用参数绑定已变化。");
        this.check(signal);
      };
      const allowed = permission === "allow" || await confirm({ intentId: intent.id, permission, invocation: preview }, recheck);
      this.check(signal);
      requireThat(canonical(this.providers.permissions.read()) === permissions, "确认期间工具权限已变化。");
      if (!allowed) return this.ledger.decline(intent.id);
      const op = this.providers.operation(provider, operation);
      const observation = await this.providers.send(provider, operation, parameters, binding, permissions, () => {
        this.check(signal);
        requireThat(!entered, "本次发送已记录，不能重发。");
        this.ledger.start(intent.id);
        entered = true;
      }, signal);
      requireThat(entered, "发送入口未记录尝试。");
      const outcome = classify(observation, op);
      const receipt = { id: randomUUID(), at: new Date().toISOString(), success: outcome === "accepted" };
      try {
        const saved = this.ledger.observe(intent.id, observation, outcome, receipt);
        return { ...saved, data: observation.data, dataPath: this.store.calls.receipt(receipt.id)!.dataPath };
      }
      catch {
        this.#healthy = false;
        throw new Error("回执未能可靠保存，不得自动重发。请核对 intent：" + intent.id);
      }
    } catch (error) {
      if (!this.#healthy) throw error;
      if (entered) {
        try { return this.ledger.unknown(intent.id); }
        catch {
          this.#healthy = false;
          throw new Error("发送后记录保存失败，不得重发。请核对 intent：" + intent.id);
        }
      }
      this.ledger.decline(intent.id);
      throw error;
    }
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#active]);
  }
}

export function classify(observation: Observation, operation: Pick<Operation, "outcomes">): "accepted" | "rejected" | "unknown" {
  if (!observation.success) return "unknown";
  if (!operation.outcomes) return "accepted";
  const accepted = !!schema(operation.outcomes.accepted)(observation.data);
  const rejected = !!schema(operation.outcomes.rejected)(observation.data);
  return accepted === rejected ? "unknown" : accepted ? "accepted" : "rejected";
}

import { randomUUID } from "node:crypto";
import { canonical, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { Intent, Scope } from "../model/execution-intent.js";
import { Receipt } from "../model/receipt.js";
import type { Store } from "../storage/store.js";
import { classify, type ProviderRegistry } from "./provider-registry.js";
import { Ledger } from "./execution-ledger.js";

export class ExecutionService {
  private readonly ledger: Ledger;
  readonly #active = new Set<Promise<Intent>>();
  #closed = false;
  #healthy = true;
  constructor(private readonly providers: ProviderRegistry, private readonly store: Store) {
    this.ledger = new Ledger(store); this.ledger.recover();
  }
  get(id: string) { return this.ledger.get(id); }
  unsettled() { return this.ledger.unsettled(); }
  call(scope: Scope, provider: string, operation: string, parameters: Params,
    confirm: (preview: unknown) => Promise<boolean> = async () => false, signal?: AbortSignal): Promise<Intent> {
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
    confirm: (preview: unknown) => Promise<boolean>, signal?: AbortSignal) {
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
      const allowed = permission === "allow" || await confirm({ intentId: intent.id, permission, invocation: preview });
      this.check(signal);
      requireThat(canonical(this.providers.permissions.read()) === permissions, "确认期间工具权限已变化。");
      if (!allowed) return this.ledger.decline(intent.id);
      const op = this.providers.operation(provider, operation);
      const observation = await this.providers.send(provider, operation, parameters, binding, permissions, () => {
        this.check(signal);
        requireThat(!entered, "本次发送已记录，不能重发。");
        this.ledger.start(intent.id); entered = true;
      }, signal);
      requireThat(entered, "发送入口未记录尝试。");
      const outcome = classify(observation, op);
      const receipt = new Receipt({ id: randomUUID(), provider, operation, parameters: structuredClone(parameters),
        binding, at: new Date().toISOString(), success: outcome === "accepted", data: observation.data });
      try { return this.ledger.observe(intent.id, observation, outcome, receipt); }
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
  async resolve(id: string, note: string, confirm: (value: unknown) => Promise<boolean>, signal?: AbortSignal) {
    this.check(signal);
    requireThat(await confirm({ intent: { ...this.ledger.get(id) }, note }), "用户未确认结案。");
    this.check(signal); return this.ledger.resolve(id, note);
  }
  async close() { this.#closed = true; await Promise.allSettled([...this.#active]); }
}

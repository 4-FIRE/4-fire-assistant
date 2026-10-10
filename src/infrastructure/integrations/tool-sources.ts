import type { DispatchPermit, ToolPort } from "../../application/business-ports.js";
import { AssistantError } from "../../application/ports.js";
import type { OperationSpec, Role, Scope } from "../../domain/shared.js";

/** Namespaces preserve native inputs and avoid collisions between unrelated services. */
export class ToolSources implements ToolPort {
  readonly #sources: ReadonlyMap<string, ToolPort>;
  readonly #disabled = new Set<string>();
  constructor(sources: ReadonlyMap<string, ToolPort>) {
    for (const id of sources.keys()) if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new AssistantError("INVALID_SOURCE_ID", "工具来源标识须为小写字母、数字和连字符。");
    this.#sources = new Map(sources);
  }
  private resolve(name: string) {
    const separator = name.indexOf("/");
    const id = name.slice(0, separator);
    const source = this.#disabled.has(id) ? undefined : this.#sources.get(id);
    if (separator < 1 || !source || !name.slice(separator + 1)) throw new AssistantError("SOURCE_UNAVAILABLE", "工具来源或操作未配置。");
    return { source, nativeName: name.slice(separator + 1) };
  }
  status() { return Object.fromEntries([...this.#sources].map(([id, source]) => [id, { disabled: this.#disabled.has(id), detail: source.status() }])); }
  catalog() { return [...this.#sources].filter(([id]) => !this.#disabled.has(id)).flatMap(([id, source]) => source.catalog().map(tool => ({ ...tool, name: `${id}/${tool.name}` }))); }
  kind(name: string) { const { source, nativeName } = this.resolve(name); return source.kind(nativeName); }
  allowed(name: string, role: Role): boolean {
    const { source, nativeName } = this.resolve(name);
    return source.allowed ? source.allowed(nativeName, role) : true;
  }
  requirements(name: string) { const { source, nativeName } = this.resolve(name); return source.requirements?.(nativeName) ?? { reviewRequired: true, confirmationRequired: true as const }; }
  binding(name: string) { const { source, nativeName } = this.resolve(name); return source.binding(nativeName); }
  async refresh(signal?: AbortSignal) {
    // A failed source does not prevent independent sources from serving reads.
    const entries = [...this.#sources].filter(([id]) => !this.#disabled.has(id));
    const results = await Promise.allSettled(entries.map(([, source]) => source.refresh(signal)));
    results.forEach((result, index) => { if (result.status === "rejected") this.#disabled.add(entries[index]![0]); });
    signal?.throwIfAborted();
  }
  validate(operation: OperationSpec) {
    const { source, nativeName } = this.resolve(operation.name);
    source.validate({ name: nativeName, parameters: operation.parameters });
  }
  async read(operation: OperationSpec, signal?: AbortSignal) {
    const { source, nativeName } = this.resolve(operation.name);
    return source.read({ name: nativeName, parameters: operation.parameters }, signal);
  }
  async dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal) {
    const { source, nativeName } = this.resolve(operation.name);
    return source.dispatch({ consume: (binding, actual, actualScope) => {
      if (actual.name !== nativeName) throw new AssistantError("DISPATCH_PERMIT_DENIED", "实际原生操作与方案不匹配。");
      permit.consume(binding, { name: operation.name, parameters: actual.parameters }, actualScope);
    } }, { name: nativeName, parameters: operation.parameters }, scope, signal);
  }
}

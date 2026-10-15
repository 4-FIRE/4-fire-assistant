import { randomUUID } from "node:crypto";
import { canonical } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { Provider, type Operation } from "../../model/provider.js";
import type { ManagementFailure, ManagementRequest, ManagementUpdate, Connection } from "../../model/provider-management.js";
import { parseProvider, operationContract } from "../../storage/provider-config.js";

export class ProviderEditError extends Error {
  constructor(readonly failure: ManagementFailure) { super(failure.message); }
}
export function conflict(path: string): never {
  throw new ProviderEditError({ category: "conflict", path, message: "对象已变化或版本已失效。", next: "使用 read 重新读取该对象后提交。" });
}

/** Instance-scoped opaque snapshots, not file hashes or persistent format versions. */
export class ProviderRevisions {
  readonly #values = new Map<string, { value: string; revision: string }>();
  revision(key: string, value: unknown) {
    const text = canonical(value), old = this.#values.get(key);
    if (old?.value === text) return old.revision;
    const entry = { value: text, revision: randomUUID() };
    this.#values.set(key, entry); return entry.revision;
  }
  check(key: string, value: unknown, expected: string) {
    if (this.revision(key, value) !== expected) conflict(key);
  }
  clear() { this.#values.clear(); }
}
export function connectionConfig(provider: Provider): Connection {
  const { id: _id, operations: _operations, coverage: _coverage, discovery: _discovery, ...config } = provider;
  return config as Connection;
}
export function editableOperation(operation: Operation) {
  const { native: _native, outcomes: _outcomes, ...definition } = operation;
  return definition;
}
export function operationVersion(provider: Provider, operation: Operation) {
  return { connection: connectionConfig(provider), operation: { ...operation } };
}
export function prepareProviderEdit(previous: Provider | undefined,
  request: Extract<ManagementRequest, { action: "register" | "update" }>, revisions: ProviderRevisions) {
  let next: Provider, cleared: string[] = [];
  if (request.action === "register") {
    requireThat(!previous, "provider：已注册，请读取后使用 update。");
    requireThat(request.config.kind === "cli" || request.operations === undefined && request.coverage === undefined && request.permissions === undefined,
      "config：MCP 注册只接受连接配置，不接受目录或初始权限。");
    next = parseProvider({ ...request.config, id: request.provider, operations: request.operations ?? [],
      ...(request.coverage ? { coverage: request.coverage } : {}) });
    if (next.kind === "mcp") next.discovery = { status: "stale", at: "", scope: "连接已注册，尚未完成发现。" };
  } else {
    requireThat(previous, "provider：尚未注册。");
    if (request.target === "permissions") next = previous;
    else ({ next, cleared } = editProvider(previous, request, revisions));
  }
  return { next, cleared,
    permissionsOnly: request.action === "update" && request.target === "permissions",
    reconnect: request.action === "register" || request.target === "connection" };
}
function editProvider(previous: Provider, request: Exclude<ManagementUpdate, { target: "permissions" }>, revisions: ProviderRevisions) {
  const next = new Provider(structuredClone(previous));
  const key = (target: string) => `${previous.id}/${target}`;
  const cleared: string[] = [];
  const cli = () => requireThat(previous.kind === "cli", "target：此维护动作仅用于 CLI。");
  switch (request.target) {
    case "connection": {
      revisions.check(key("connection"), connectionConfig(previous), request.expectedRevision);
      requireThat(request.config.kind === previous.kind, "config.kind：更换提供方类型须使用新 ID。");
      const changed = new Provider({ ...request.config, id: previous.id, operations: next.operations,
        ...(next.coverage ? { coverage: next.coverage } : {}) });
      if (changed.kind === "mcp") {
        changed.operations = changed.operations.map(operation => ({ ...operation, available: false }));
        changed.discovery = { status: "stale", at: previous.discovery?.at ?? "", scope: "连接已重新确认，必须重新发现。" };
      }
      return { next: parseProvider(changed), cleared };
    }
    case "coverage":
      cli(); revisions.check(key("coverage"), previous.coverage, request.expectedRevision);
      next.coverage = request.coverage; break;
    case "outcomes": {
      const op = next.operations.find(op => op.name === request.operation);
      requireThat(op, "operation：未知操作，请查询目录。");
      revisions.check(key(`outcomes/${op.name}`), operationVersion(previous, op), request.expectedRevision);
      if (request.outcomes === null) delete op.outcomes;
      else op.outcomes = request.outcomes;
      break;
    }
    case "operations": {
      cli();
      const adds = request.add ?? [], replacements = request.replace ?? [];
      requireThat(adds.length + replacements.length > 0, "add/replace：至少提交一个接口。");
      const names = [...adds.map(op => op.name), ...replacements.map(item => item.definition.name)];
      requireThat(new Set(names).size === names.length, "add/replace：接口名不能重复。");
      for (const definition of adds) {
        requireThat(!next.operations.some(op => op.name === definition.name), "add：接口已存在，请使用 replace。");
        next.operations.push(definition);
      }
      for (const { expectedRevision, definition } of replacements) {
        const index = previous.operations.findIndex(op => op.name === definition.name), old = previous.operations[index];
        requireThat(old, "replace：接口不存在，请使用 add。");
        requireThat(!Object.hasOwn(definition, "outcomes"), "replace.definition.outcomes：结果契约请使用 outcomes 分支修改。");
        revisions.check(key(`operations/${old.name}`), operationVersion(previous, old), expectedRevision);
        const sameContract = canonical(operationContract("cli", old)) === canonical(operationContract("cli", definition));
        next.operations[index] = { ...definition, ...(sameContract && old.outcomes ? { outcomes: old.outcomes } : {}) };
        if (!sameContract && old.outcomes) cleared.push(old.name);
      }
      if (request.coverage) {
        revisions.check(key("coverage"), previous.coverage, request.coverage.expectedRevision);
        next.coverage = request.coverage.value;
      }
      break;
    }
  }
  return { next: parseProvider(next), cleared };
}

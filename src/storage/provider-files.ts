import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonical, object, type Params } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { Operation, Provider } from "../model/provider.js";
import { parseProvider, providerData, operationContract } from "./provider-config.js";
import { entries, privateDirectory, type FileAccess } from "./file-access.js";

export function providerId(id: string) { requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(id), "提供方 ID 无效。"); return id; }
export function splitProvider(value: unknown): Record<string, Params> {
  const provider = parseProvider(value);
  const { id: _id, operations, coverage, discovery, ...config } = providerData(provider);
  const definitions = provider.operations.map(({ outcomes: _outcomes, ...op }) => op);
  const outcomes = Object.fromEntries(provider.operations.filter(op => op.outcomes).map(op =>
    [op.name, { contract: operationContract(provider.kind, op), outcomes: op.outcomes! }]));
  requireThat(provider.kind !== "mcp" || discovery && coverage === undefined, "MCP 目录需要 discovery 且不能包含 CLI coverage。");
  return { "config.json": config, "outcomes.json": outcomes,
    ...(provider.kind === "cli" ? { "operations.json": { operations: definitions, coverage: coverage! } }
      : { "catalog.json": { operations: definitions, discovery: discovery! } }) } as Record<string, Params>;
}
export function joinProvider(id: string, files: Record<string, Params>): Provider {
  providerId(id);
  const config = files["config.json"], rules = files["outcomes.json"];
  requireThat(object(config) && object(rules) && ["cli", "mcp"].includes(String(config.kind)), "提供方配置不完整。");
  const name = config.kind === "cli" ? "operations.json" : "catalog.json", catalog = files[name];
  requireThat(Object.keys(files).sort().join() === ["config.json", "outcomes.json", name].sort().join(), "提供方文件集合无效。");
  requireThat(Object.keys(config).every(key => ["kind", "command", "args", "env", "url", "headers"].includes(key)), "连接文件含有未知字段。");
  requireThat(object(catalog) && Object.keys(catalog).sort().join() === (config.kind === "cli" ? "coverage,operations" : "discovery,operations") &&
    Array.isArray(catalog.operations), "提供方目录结构无效。");
  requireThat(catalog.operations.every(op => object(op) && !Object.hasOwn(op, "outcomes")), "目录文件不能重复保存 outcomes。");
  const provider = parseProvider({ id, ...config, ...catalog });
  for (const [name, entry] of Object.entries(rules)) {
    const op = provider.operations.find(op => op.name === name);
    requireThat(op && object(entry) && Object.keys(entry).sort().join() === "contract,outcomes" &&
      canonical(entry.contract) === canonical(operationContract(provider.kind, op)), "结果契约与接口失配；请核对 outcomes 文件。");
    op.outcomes = entry.outcomes as unknown as NonNullable<Operation["outcomes"]>;
  }
  return providerData(parseProvider(providerData(provider))) as unknown as Provider;
}
export class ProviderFileError extends Error {
  constructor(readonly completed: string[], cause: unknown) { super("提供方文件未全部可靠保存；已完成阶段不会回滚。", { cause }); }
}
export class ProviderFiles {
  readonly #loaded = new Map<string, { value: Provider; files: Record<string, Params> }>();
  constructor(private readonly files: FileAccess) {
    for (const id of entries(files.directory, "providers", true)) {
      const data = this.readFiles(providerId(id)); this.#loaded.set(id, { files: data, value: joinProvider(id, data) });
    }
  }
  private readFiles(id: string) {
    const data: Record<string, Params> = {};
    for (const name of entries(this.files.directory, "providers/" + providerId(id))) {
      requireThat(["config.json", "operations.json", "outcomes.json", "catalog.json"].includes(name), "未知提供方文件。");
      data[name] = this.files.read(`providers/${id}/${name}`, value => { requireThat(object(value), "提供方文件必须是对象。"); return value as Params; });
    }
    return data;
  }
  get(id: string): Provider | undefined {
    this.files.check(); providerId(id);
    const loaded = this.#loaded.get(id);
    if (!loaded) { requireThat(!existsSync(join(this.files.directory, "providers", id)), "提供方文件已变化，请 /reload。"); return undefined; }
    requireThat(canonical(this.readFiles(id)) === canonical(loaded.files), "提供方文件已变化，请 /reload 后重新批准。");
    return structuredClone(loaded.value);
  }
  list() {
    this.files.check();
    requireThat(canonical(entries(this.files.directory, "providers", true)) === canonical([...this.#loaded.keys()].sort()), "提供方文件集合已变化，请 /reload。");
    return [...this.#loaded.keys()].sort().map(id => this.get(id)!);
  }
  save(id: string, value: unknown): string[] {
    providerId(id); const next = splitProvider(value);
    requireThat(parseProvider(value).id === id, "提供方 ID 不一致。");
    this.get(id);
    const previous = this.#loaded.get(id)?.files, completed: string[] = [];
    requireThat(!previous || previous["config.json"]!.kind === next["config.json"]!.kind, "更换提供方类型必须使用新 ID。");
    try {
      this.files.mutate(() => privateDirectory(this.files.directory, "providers/" + id));
      for (const name of ["config.json", next["operations.json"] ? "operations.json" : "catalog.json", "outcomes.json"]) {
        if (previous?.[name] && canonical(previous[name]) === canonical(next[name])) continue;
        this.files.write(`providers/${id}/${name}`, next[name], value => { requireThat(object(value), "提供方文件无效。"); return value; });
        completed.push(name);
      }
      this.#loaded.set(id, { files: structuredClone(next), value: joinProvider(id, next) });
      return completed;
    } catch (error) { throw new ProviderFileError(completed, error); }
  }
}

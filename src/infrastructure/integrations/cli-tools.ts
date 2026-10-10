import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { compileToolSchema } from "./schema.js";
import type { DispatchPermit, NativeObservation, ToolPort } from "../../application/business-ports.js";
import { AssistantError } from "../../application/ports.js";
import { canonical, object, type Json, type OperationSpec, type Parameters, type Scope, type ServiceBinding } from "../../domain/shared.js";
import { classifyWrite, type WriteResultContract } from "./write-result.js";
import type { WriteRequirements } from "../../application/business-ports.js";
import { digest } from "./mcp.js";

export interface CliOperation {
  name: string;
  description: string;
  access: "read" | "write";
  execution?: WriteRequirements;
  outcomes?: WriteResultContract;
  schema: Parameters;
  /** Fixed native arguments, one complete JSON input, or explicit scalar field bindings. No shell. */
  argv: (string | { parameters: "json" } | { parameter: string })[];
  stdin?: "json";
  resultSchema?: Parameters;
}
export interface CliConfig {
  command: string;
  operations: CliOperation[];
  /** Explicit environment references; values are resolved only by the host. */
  env?: Record<string, string>;
  /** Files used to select the external target. Changes disable this connection. */
  bindingFiles?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}
function invalid(): never { throw new AssistantError("INVALID_CLI_CONTRACT", "CLI 调用约定无效；需要绝对入口、明确参数、执行要求和可校验 schema。"); }
function schema(value: unknown): Parameters { if (!object(value)) invalid(); canonical(value as Parameters); return value as Parameters; }
export function parseCliConfig(value: unknown): CliConfig {
  if (!object(value) || typeof value.command !== "string" || !isAbsolute(value.command) ||
      !Array.isArray(value.operations) || Object.keys(value).some(k => !["command", "operations", "env", "bindingFiles", "timeoutMs", "maxOutputBytes"].includes(k))) invalid();
  const names = new Set<string>();
  const operations = value.operations.map(item => {
    if (!object(item) || typeof item.name !== "string" || !item.name.trim() || item.name !== item.name.trim() || names.has(item.name) ||
        typeof item.description !== "string" || !["read", "write"].includes(String(item.access)) || !Array.isArray(item.argv) ||
        Object.keys(item).some(k => !["name", "description", "access", "schema", "argv", "stdin", "resultSchema", "execution", "outcomes"].includes(k))) invalid();
    names.add(item.name);
    const argv = item.argv.map(token => {
      if (typeof token === "string" && !token.includes("\0")) return token;
      if (!object(token) || Object.keys(token).length !== 1) invalid();
      if (token.parameters === "json") return { parameters: "json" as const };
      if (typeof token.parameter === "string" && token.parameter && !token.parameter.includes("\0")) return { parameter: token.parameter };
      return invalid();
    });
    if (item.stdin !== undefined && item.stdin !== "json") invalid();
    const jsonChannels = argv.filter(token => typeof token !== "string" && "parameters" in token).length + (item.stdin === "json" ? 1 : 0);
    const fields = argv.flatMap(token => typeof token !== "string" && "parameter" in token ? [token.parameter] : []);
    if (jsonChannels > 1 || jsonChannels && fields.length) invalid();
    const inputSchema = schema(item.schema); compileToolSchema(inputSchema);
    if (inputSchema.type !== "object") invalid();
    if (!jsonChannels) {
      // Every accepted parameter must have an explicit native binding; no silently ignored inputs.
      const properties = inputSchema.properties ?? {};
      if (!object(properties) || inputSchema.additionalProperties !== false || new Set(fields).size !== fields.length ||
          Object.keys(properties).length !== fields.length || fields.some(field => !Object.hasOwn(properties, field) ||
            !object(properties[field]) || !["string", "number", "integer", "boolean"].includes(String(properties[field].type))) ||
          fields.length && (!Array.isArray(inputSchema.required) || fields.some(field => !(inputSchema.required as unknown[]).includes(field)))) invalid();
    }
    const resultSchema = item.resultSchema === undefined ? undefined : schema(item.resultSchema);
    if (resultSchema) compileToolSchema(resultSchema);
    let execution: WriteRequirements | undefined, outcomes: WriteResultContract | undefined;
    if (item.access === "write") {
      if (!object(item.execution) || typeof item.execution.reviewRequired !== "boolean" || item.execution.confirmationRequired !== true ||
          Object.keys(item.execution).some(k => !["reviewRequired", "confirmationRequired"].includes(k)) || !object(item.outcomes) ||
          Object.keys(item.outcomes).some(k => !["accepted", "rejected"].includes(k))) invalid();
      execution = { reviewRequired: item.execution.reviewRequired, confirmationRequired: true };
      outcomes = { accepted: schema(item.outcomes.accepted), rejected: schema(item.outcomes.rejected) };
      for (const value of Object.values(outcomes)) {
        if (value.type !== "object" || !Array.isArray(value.required) || !value.required.length) invalid();
        compileToolSchema(value);
      }
    } else if (item.execution !== undefined || item.outcomes !== undefined) invalid();
    return { name: item.name, description: item.description, access: item.access as "read" | "write", schema: inputSchema, argv,
      ...(execution && outcomes ? { execution, outcomes } : {}),
      ...(item.stdin === "json" ? { stdin: "json" as const } : {}), ...(resultSchema ? { resultSchema } : {}) };
  });
  if (value.env !== undefined && (!object(value.env) || Object.entries(value.env).some(([key, ref]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)))) invalid();
  if (value.bindingFiles !== undefined && (!Array.isArray(value.bindingFiles) || !value.bindingFiles.every(p => typeof p === "string" && isAbsolute(p)))) invalid();
  for (const [key, max] of [["timeoutMs", 120_000], ["maxOutputBytes", 16 * 1024 * 1024]] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > max)) invalid();
  }
  return structuredClone({ command: value.command, operations,
    ...(value.env ? { env: value.env as Record<string, string> } : {}),
    ...(value.bindingFiles ? { bindingFiles: value.bindingFiles as string[] } : {}),
    ...(value.timeoutMs ? { timeoutMs: value.timeoutMs as number } : {}),
    ...(value.maxOutputBytes ? { maxOutputBytes: value.maxOutputBytes as number } : {}) });
}
async function fileDigest(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new AssistantError("CLI_FILE_UNAVAILABLE", "CLI 入口或绑定文件不是可读取的普通文件。");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Native calls with fixed input binding and one-use write permits. */
export class CliTools implements ToolPort {
  readonly #epoch = randomUUID();
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #results = new Map<string, ValidateFunction>();
  #ready = true;
  private constructor(private readonly config: CliConfig, private readonly cwd: string,
    private readonly environment: Record<string, string>, private readonly fingerprint: string) {
    for (const item of config.operations) {
      this.#validators.set(item.name, compileToolSchema(item.schema));
      if (item.resultSchema) this.#results.set(item.name, compileToolSchema(item.resultSchema));
    }
  }
  static async open(input: CliConfig, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<CliTools> {
    const config = parseCliConfig(input);
    config.command = await realpath(config.command);
    const environment: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
    for (const [key, ref] of Object.entries(config.env ?? {})) {
      if (env[ref] === undefined) throw new AssistantError("CLI_ENV_MISSING", "CLI 所需环境引用未设置；请在本机配置。");
      environment[key] = env[ref]!;
    }
    return new CliTools(config, await realpath(cwd), environment, await CliTools.fingerprint(config));
  }
  private static async fingerprint(config: CliConfig): Promise<string> {
    const hashes = await Promise.all([config.command, ...(config.bindingFiles ?? [])].map(async path => ({ path, digest: await fileDigest(path) })));
    return digest(hashes);
  }
  catalog() { return this.#ready ? this.config.operations.map(item => ({ name: item.name, description: item.description,
    kind: item.access, schema: structuredClone(item.schema), schemaDigest: digest(item.schema) })) : []; }
  status(): Json { return { transport: "cli", ready: this.#ready, epoch: this.#epoch, operations: this.catalog().length }; }
  kind(name: string) { return this.#ready ? this.config.operations.find(item => item.name === name)?.access : undefined; }
  requirements(name: string): WriteRequirements {
    const item = this.config.operations.find(item => item.name === name);
    if (!item?.execution) throw new AssistantError("WRITE_CONTRACT_REQUIRED", "操作没有写入约定。");
    return structuredClone(item.execution);
  }
  binding(name: string): ServiceBinding {
    const item = this.catalog().find(item => item.name === name);
    if (!item) throw new AssistantError("OPERATION_UNAVAILABLE", "CLI 操作未启用或入口已变化。");
    return { connectionId: digest({ command: this.config.command, cwd: this.cwd, fingerprint: this.fingerprint, environment: this.environment }),
      epoch: this.#epoch, accessDigest: digest(this.config as unknown as Json), schemaDigest: item.schemaDigest };
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#ready) throw new AssistantError("CLI_CHANGED", "CLI 入口或目标配置已变化；重新核对后再启动。");
    try { if (await CliTools.fingerprint(this.config) === this.fingerprint) return; }
    catch { /* A removed or unreadable binding is also a change. */ }
    this.#ready = false;
    throw new AssistantError("CLI_CHANGED", "CLI 入口或目标配置已变化；当前来源已停用。");
  }
  validate(operation: OperationSpec): void {
    this.binding(operation.name); canonical(operation.parameters);
    if (!this.#validators.get(operation.name)?.(operation.parameters) || Object.values(operation.parameters).some(value => typeof value === "string" && value.includes("\0"))) throw new AssistantError("SCHEMA_REJECTED", "CLI 参数不符合已确认的输入约定；未启动程序。");
  }
  async read(operation: OperationSpec, signal?: AbortSignal): Promise<NativeObservation> {
    if (this.kind(operation.name) !== "read") throw new AssistantError("OPERATION_DENIED", "只读入口不能执行写入。");
    return this.invoke(operation, signal);
  }
  private async invoke(operation: OperationSpec, signal?: AbortSignal, beforeSpawn?: () => void): Promise<NativeObservation> {
    // Capture before the first await. Caller mutations cannot alter the validated native input.
    const exact = structuredClone(operation);
    this.validate(exact); await this.refresh(signal);
    const parameters = canonical(exact.parameters);
    const item = this.config.operations.find(item => item.name === exact.name)!;
    const args = item.argv.map(token => typeof token === "string" ? token : "parameters" in token ? parameters : String(operation.parameters[token.parameter]));
    const raw = await this.run(args, item.stdin === "json" ? parameters : undefined, signal, beforeSpawn);
    let data: Json = raw.stdout || raw.stderr;
    try { data = JSON.parse(String(data)) as Json; } catch { /* Text is a valid read result. */ }
    if (raw.incomplete) {
      if (!beforeSpawn) throw new AssistantError("CLI_READ_FAILED", "CLI 查询未完成、取消或超过限制；不能视为有效数据。");
      return { success: false, outcome: "unknown", data, raw };
    }
    const validator = this.#results.get(exact.name);
    return { success: raw.exitCode === 0 && (!validator || !!validator(data)), data, raw };
  }
  async dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal): Promise<NativeObservation> {
    const exact = structuredClone(operation);
    const item = this.config.operations.find(item => item.name === exact.name);
    if (!item?.outcomes || item.access !== "write") throw new AssistantError("WRITE_CONTRACT_REQUIRED", "操作没有写入结果约定。");
    let crossed = false;
    try {
      const result = await this.invoke(exact, signal, () => {
        permit.consume(this.binding(exact.name), exact, scope);
        crossed = true;
      });
      if (result.outcome === "unknown") return result;
      return classifyWrite(result, compileToolSchema(item.outcomes.accepted), compileToolSchema(item.outcomes.rejected));
    } catch (error) {
      if (!crossed) throw new AssistantError("PROVEN_NOT_SENT", "发送前检查失败；未调用 CLI。");
      throw error;
    }
  }
  private run(args: string[], input: string | undefined, signal?: AbortSignal, beforeSpawn?: () => void): Promise<{ stdout: string; stderr: string; exitCode: number | null; incomplete?: boolean }> {
    signal?.throwIfAborted();
    return new Promise(resolve => {
      beforeSpawn?.();
      const child = spawn(this.config.command, args, { cwd: this.cwd, env: this.environment, shell: false,
        detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, failed = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ } } };
      const fail = () => { failed = true; kill(); };
      const timer = setTimeout(fail, this.config.timeoutMs ?? 15_000);
      signal?.addEventListener("abort", fail, { once: true });
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (this.config.maxOutputBytes ?? 1024 * 1024)) fail(); else into.push(chunk);
      };
      child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
      child.on("error", fail); child.stdin.on("error", fail);
      child.once("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", fail); kill();
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code,
          ...(failed || signal?.aborted ? { incomplete: true } : {}) });
      });
      if (signal?.aborted) fail();
      child.stdin.end(input);
    });
  }
}

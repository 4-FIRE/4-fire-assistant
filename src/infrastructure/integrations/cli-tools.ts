import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { compileToolSchema } from "./tool-schema.js";
import type { DispatchPermit, NativeObservation, ToolPort } from "../../application/business-ports.js";
import { AssistantError } from "../../application/ports.js";
import { canonical, type Json, type OperationSpec, type Scope, type ServiceBinding } from "../../domain/shared.js";
import { classifyWrite } from "./write-result.js";
import { parseCliConfig, type CliConfig } from "./cli-contract.js";
import type { WriteRequirements } from "../../application/business-ports.js";
import { digest } from "../digest.js";

/** Native calls with fixed input binding and one-use write permits. */
export class CliTools implements ToolPort {
  #epoch = randomUUID();
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #results = new Map<string, ValidateFunction>();
  #ready = true;
  private constructor(private readonly config: CliConfig, private readonly cwd: string,
    private readonly environment: Record<string, string>) {
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
    await access(config.command, constants.X_OK);
    return new CliTools(config, await realpath(cwd), environment);
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
    return { connectionId: digest({ command: this.config.command, cwd: this.cwd, environment: this.environment }),
      epoch: this.#epoch, accessDigest: digest(this.config as unknown as Json), schemaDigest: item.schemaDigest };
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try { await access(this.config.command, constants.X_OK); }
    catch {
      if (this.#ready) this.#epoch = randomUUID();
      this.#ready = false;
      throw new AssistantError("CLI_CHANGED", "CLI 入口不可用；请修复入口后刷新来源目录。");
    }
    this.#ready = true;
  }
  validate(operation: OperationSpec): void {
    this.binding(operation.name); canonical(operation.parameters);
    if (!this.#validators.get(operation.name)?.(operation.parameters) || Object.values(operation.parameters).some(value => typeof value === "string" && value.includes("\0"))) throw new AssistantError("SCHEMA_REJECTED", "CLI 参数不符合已确认的输入约定；未启动程序。");
  }
  preview(operation: OperationSpec): Json {
    this.validate(operation);
    const item = this.config.operations.find(item => item.name === operation.name)!;
    return { command: this.config.command, cwd: this.cwd,
      argv: item.argv.map(token => typeof token === "string" ? token : "parameters" in token ? canonical(operation.parameters) : String(operation.parameters[token.parameter])),
      ...(item.stdin === "json" ? { stdin: canonical(operation.parameters) } : {}), envRefs: this.config.env ?? {} };
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
    const args = item.argv.map(token => typeof token === "string" ? token : "parameters" in token ? parameters : String(exact.parameters[token.parameter]));
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

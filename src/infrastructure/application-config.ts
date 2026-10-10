import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AssistantError, type ModelSelection } from "../application/ports.js";

export interface ApplicationConfig {
  version: 1;
  model?: ModelSelection;
  authPath?: string;
  modelsPath?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  runtime?: { modelTimeoutMs?: number; generationRetries?: number; progressIntervalMs?: number };
  research?: { python?: string };
}
export function machineConfigDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "4-fire-assistant");
}
export function dataDirectory(options: {
  override?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (options.override !== undefined) {
    if (!isAbsolute(options.override)) throw new AssistantError("INVALID_DATA_DIR", "--data-dir 必须是绝对路径。");
    return options.override;
  }
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "4-fire-assistant");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseModel(value: string): ModelSelection {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1 || value.trim() !== value) {
    throw new AssistantError("INVALID_MODEL", "模型格式为 provider/modelId。");
  }
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}
export function parseConfig(value: unknown): ApplicationConfig {
  if (!record(value) || value.version !== 1 ||
      Object.keys(value).some(key => !["version", "model", "authPath", "modelsPath", "thinkingLevel", "runtime", "research"].includes(key))) {
    throw new AssistantError("INVALID_CONFIG", "配置格式或版本不受支持；原文件未修改。");
  }
  const config: ApplicationConfig = { version: 1 };
  if (value.research !== undefined) {
    if (!record(value.research) || Object.keys(value.research).some(k => !["python"].includes(k)) ||
        Object.values(value.research).some(v => typeof v !== "string" || !isAbsolute(v))) invalid();
    config.research = value.research as { python?: string };
  }
  if (value.model !== undefined) {
    if (!record(value.model) || typeof value.model.provider !== "string" ||
        !value.model.provider.trim() || typeof value.model.modelId !== "string" ||
        !value.model.modelId.trim() ||
        Object.keys(value.model).some(key => !["provider", "modelId"].includes(key))) {
      throw new AssistantError("INVALID_CONFIG", "模型配置无效；原文件未修改。");
    }
    config.model = { provider: value.model.provider, modelId: value.model.modelId };
  }
  for (const key of ["authPath", "modelsPath"] as const) {
    const path = value[key];
    if (path !== undefined) {
      if (typeof path !== "string" || !isAbsolute(path)) {
        throw new AssistantError("INVALID_CONFIG", "覆盖的认证/模型路径必须是绝对路径。");
      }
      config[key] = path;
    }
  }
  if (value.thinkingLevel !== undefined) {
    if (typeof value.thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel)) invalid();
    config.thinkingLevel = value.thinkingLevel as NonNullable<ApplicationConfig["thinkingLevel"]>;
  }
  if (value.runtime !== undefined) {
    const runtime = value.runtime;
    if (!record(runtime) || Object.keys(runtime).some(k => !["modelTimeoutMs", "generationRetries", "progressIntervalMs"].includes(k))) invalid();
    for (const [key, item] of Object.entries(runtime)) {
      if (key === "generationRetries") { if (!Number.isInteger(item) || Number(item) < 0 || Number(item) > 10) invalid(); }
      else positiveInteger(item, 3600000);
    }
    config.runtime = structuredClone(runtime) as NonNullable<ApplicationConfig["runtime"]>;
  }
  return config;
}
function invalid(): never { throw new AssistantError("INVALID_CONFIG", "配置无效；原文件未修改，敏感内容不会显示。"); }
function positiveInteger(value: unknown, max: number): void { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) invalid(); }
export async function readConfig(directory: string): Promise<ApplicationConfig> {
  let text: string;
  try { text = await readFile(join(directory, "config.local.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw new AssistantError("CONFIG_UNREADABLE", "无法读取应用配置；请检查文件权限。");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new AssistantError("INVALID_CONFIG", "配置 JSON 无效；原文件未修改。"); }
  return parseConfig(value);
}
export async function writeConfig(directory: string, config: ApplicationConfig): Promise<void> {
  const validated = parseConfig(config);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, "config.local.json"));
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

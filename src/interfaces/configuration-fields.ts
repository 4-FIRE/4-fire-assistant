import { isAbsolute } from "node:path";
import { AssistantError } from "../application/ports.js";
import { parseConfig } from "../infrastructure/application-config.js";
import type { ApplicationConfig } from "../infrastructure/application-config.js";
import type { AssistantScreen } from "./screen.js";

type Values = Record<string, string>;
interface Field {
  key: string;
  label: string;
  hint?: string;
  choices?: { value: string; label: string }[];
  validate?: (value: string) => void;
}
function invalid(message: string): never { throw new AssistantError("INVALID_CONFIG", message); }
function absolute(value: string): void {
  if (value && !isAbsolute(value)) invalid("请输入绝对路径，例如 /home/user/file。不要使用 ~ 或相对路径。");
}
function integer(max: number, min = 1): (value: string) => void {
  return value => {
    if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)) {
      invalid(`请输入 ${min} 至 ${max} 的整数。留空使用默认值。`);
    }
  };
}
const pathHint = "请输入绝对路径。留空使用默认路径。按 Ctrl+U 删除光标前的内容。";

/** Each section edits local values. Only Apply replaces that section in the configuration draft. */
async function form(screen: AssistantScreen, title: string, values: Values, fields: () => Field[],
  build: () => ApplicationConfig, extra?: { visible: () => boolean; label: () => string; edit: () => Promise<void> }): Promise<ApplicationConfig | undefined> {
  while (true) {
    const visible = fields();
    const action = await screen.choose(`${title} · Enter 编辑 · Esc 放弃本页修改`, [
      ...visible.map(field => ({ value: field.key, label: field.label,
        description: field.choices?.find(choice => choice.value === values[field.key])?.label ?? (values[field.key] || "未设置，使用默认值") })),
      ...(extra?.visible() ? [{ value: "args", label: "启动参数", description: extra.label() }] : []),
      { value: "apply", label: "加入配置草稿", description: "返回配置菜单后，请选择「保存配置」" },
      { value: "back", label: "返回并放弃本页修改" },
    ]);
    if (!action || action === "back") return undefined;
    if (action === "args" && extra) { await extra.edit(); continue; }
    if (action === "apply") {
      try { return parseConfig(build()); }
      catch (error) { screen.notify(error instanceof AssistantError ? error.message : "配置无效。请检查本页设置。"); }
      continue;
    }
    const field = visible.find(item => item.key === action);
    if (!field) continue;
    if (field.choices) {
      const choice = await screen.choose(field.label, field.choices);
      if (choice !== undefined) values[field.key] = choice;
      continue;
    }
    let error = "";
    while (true) {
      const answer = await screen.ask([field.label, field.hint, error].filter(Boolean).join("\n"), values[field.key] ?? "");
      if (answer === undefined) break;
      try { const value = answer.trim(); field.validate?.(value); values[field.key] = value; break; }
      catch (cause) { error = cause instanceof AssistantError ? cause.message : "输入无效。请重新输入。"; }
    }
  }
}

export async function configureRuntime(screen: AssistantScreen, current: ApplicationConfig): Promise<ApplicationConfig | undefined> {
  const values: Values = { modelTimeoutMs: String(current.runtime?.modelTimeoutMs ?? ""), generationRetries: String(current.runtime?.generationRetries ?? ""), progressIntervalMs: String(current.runtime?.progressIntervalMs ?? "") };
  return form(screen, "模型超时与回答更新", values, () => [
    { key: "modelTimeoutMs", label: "模型超时（毫秒）", hint: "例如，120000 表示 120 秒。留空使用 SDK 默认值。", validate: integer(3600000) },
    { key: "generationRetries", label: "模型回答重试次数", hint: "请输入 0 至 10。此设置不改变交易重试规则。留空使用 SDK 默认值。", validate: integer(10, 0) },
    { key: "progressIntervalMs", label: "回答更新间隔（毫秒）", hint: "例如，100 表示每 100 毫秒更新一次。留空使用 SDK 默认值。", validate: integer(3600000) },
  ], () => {
    const next = structuredClone(current);
    const runtime = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "").map(([key, value]) => [key, Number(value)]));
    if (Object.keys(runtime).length) next.runtime = runtime;
    else delete next.runtime;
    return next;
  });
}

export async function configurePaths(screen: AssistantScreen, current: ApplicationConfig): Promise<ApplicationConfig | undefined> {
  const values: Values = { authPath: current.authPath ?? "", modelsPath: current.modelsPath ?? "" };
  return form(screen, "自定义路径 · 原文件不会移动", values, () => [
    { key: "authPath", label: "Pi 认证文件路径", hint: pathHint + "加入配置草稿后，登录操作使用新路径。取消配置不会退出登录。", validate: absolute },
    { key: "modelsPath", label: "Pi 模型文件路径", hint: pathHint + "加入配置草稿后，可返回配置菜单选择新文件中的模型。", validate: absolute },
  ], () => {
    const next = structuredClone(current);
    for (const key of ["authPath", "modelsPath"] as const) {
      if (values[key]) next[key] = values[key];
      else delete next[key];
    }
    return next;
  });
}

export function configurationSummary(config: ApplicationConfig): string {
  return [
    "是否保存以下配置？按 PgUp/PgDn 查看全部设置。",
    "模型：" + (config.model ? config.model.provider + "/" + config.model.modelId : "未选择"),
    "思考级别：" + (config.thinkingLevel ?? "默认"),
    "模型超时（毫秒）：" + (config.runtime?.modelTimeoutMs ?? "默认"),
    "模型回答重试次数：" + (config.runtime?.generationRetries ?? "默认"),
    "回答更新间隔（毫秒）：" + (config.runtime?.progressIntervalMs ?? "默认"),
    "认证文件：" + (config.authPath ?? "Pi 默认路径"),
    "模型文件：" + (config.modelsPath ?? "Pi 默认路径"),
    "Python 解释器：" + (config.research?.python ?? "python3"),
  ].join("\n");
}

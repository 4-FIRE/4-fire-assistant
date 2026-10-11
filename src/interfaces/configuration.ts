import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AssistantError } from "../application/ports.js";
import type { AuthenticationInteraction } from "../application/ports.js";
import { parseConfig, writeConfig } from "../infrastructure/application-config.js";
import type { ApplicationConfig } from "../infrastructure/application-config.js";
import { createModelRuntime, loginModel, requireModel } from "../infrastructure/model-runtime.js";
import { AssistantScreen } from "./screen.js";
import { userError } from "./terminal.js";
import { configurationSummary, configurePaths, configureRuntime } from "./configuration-fields.js";

type Models = Awaited<ReturnType<typeof createModelRuntime>>;

/** Draft changes are isolated until the user selects Save. Login uses Pi's credential store. */
export async function configureApplication(screen: AssistantScreen, current: ApplicationConfig, models: Models,
  save: (config: ApplicationConfig) => Promise<void>): Promise<ApplicationConfig | undefined> {
  const resumeInput = screen.suspendInput();
  try { return await configureDraft(screen, current, models, save); }
  finally { resumeInput(); }
}

async function configureDraft(screen: AssistantScreen, current: ApplicationConfig, models: Models,
  save: (config: ApplicationConfig) => Promise<void>): Promise<ApplicationConfig | undefined> {
  let draft = structuredClone(current);
  let loadedPaths = { authPath: current.authPath, modelsPath: current.modelsPath };
  const selectedModels = async () => {
    if (draft.authPath !== loadedPaths.authPath || draft.modelsPath !== loadedPaths.modelsPath) {
      models = await createModelRuntime(draft);
      loadedPaths = { authPath: draft.authPath, modelsPath: draft.modelsPath };
    }
    return models;
  };
  while (true) {
    const action = await screen.choose("应用配置 · 修改后请选择「保存配置」", [
      { value: "model", label: "选择模型", description: draft.model ? `${draft.model.provider}/${draft.model.modelId}` : "尚未选择" },
      { value: "login", label: "登录模型提供商", description: "凭证单独保存。取消配置不会退出登录" },
      { value: "thinking", label: "思考级别", description: draft.thinkingLevel ?? "默认" },
      { value: "runtime", label: "模型超时与回答更新", description: draft.runtime ? "自定义" : "默认" },
      { value: "paths", label: "自定义路径", description: draft.authPath || draft.modelsPath ? "使用自定义认证文件或模型文件" : "使用 Pi 默认路径" },
      { value: "import", label: "导入完整配置（高级）", description: "用 JSON 文件替换全部配置草稿" },
      { value: "save", label: "保存配置", description: "重新启动应用后，当前会话使用新配置" },
      { value: "cancel", label: "放弃配置修改", description: "不保存草稿。已完成的登录仍保留" },
    ]);
    if (!action || action === "cancel") return undefined;
    try {
      if (action === "runtime" || action === "paths") {
        const editors = { runtime: configureRuntime, paths: configurePaths };
        const updated = await editors[action](screen, draft);
        if (updated) { draft = updated; screen.notify("本页设置已加入配置草稿，但尚未保存。请选择「保存配置」。"); }
      } else if (action === "model") {
        const available = await (await selectedModels()).getAvailable();
        if (!available.length) { screen.notify("没有可用模型。请选择「登录模型提供商」。也可设置提供商支持的环境变量，然后重新启动应用。"); continue; }
        const selected = await screen.choose("选择模型 · 输入名称筛选", available.map((model, index) => ({ value: String(index), label: `${model.provider}/${model.id}` })));
        if (selected !== undefined) {
          const model = available[Number(selected)]!;
          draft.model = { provider: model.provider, modelId: model.id };
        }
      } else if (action === "thinking") {
        const level = await screen.choose("选择思考级别", ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: value === "default" ? "默认" : value })));
        if (level === "default") delete draft.thinkingLevel;
        else if (level) draft.thinkingLevel = level as NonNullable<ApplicationConfig["thinkingLevel"]>;
      } else if (action === "login") {
        const providers = (await selectedModels()).getProviders();
        const id = await screen.choose("选择模型提供商", providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.id })));
        const provider = providers.find(item => item.id === id);
        if (!provider) continue;
        const methods = [ ...(provider.auth.apiKey ? [{ value: "api_key", label: "API 密钥（隐藏输入）" }] : []), ...(provider.auth.oauth ? [{ value: "oauth", label: "OAuth 登录" }] : []) ];
        const type = await screen.choose("选择登录方式", methods);
        if (type !== "api_key" && type !== "oauth") continue;
        const controller = new AbortController();
        const cancel = screen.onCancel;
        screen.onCancel = () => controller.abort();
        const interaction: AuthenticationInteraction = {
          signal: AbortSignal.any([controller.signal, screen.signal]),
          notify: message => screen.notify(message),
          ask: async (message, secret, choices, signal) => {
            const promptSignal = AbortSignal.any([controller.signal, screen.signal, ...(signal ? [signal] : [])]);
            const value = choices
              ? await screen.choose(message, choices.map(choice => ({ value: choice.id, label: choice.label })), promptSignal)
              : await screen.ask(message, "", secret, promptSignal);
            if (value === undefined) { controller.abort(); throw new AssistantError("LOGIN_CANCELLED", "登录已取消。"); }
            return value;
          },
        };
        try { await loginModel(models, provider.id, type, interaction); screen.notify("登录已完成。现在可以选择模型。"); }
        finally { screen.onCancel = cancel; controller.abort(); }
      } else if (action === "import") {
        const path = await screen.ask("请输入配置 JSON 文件的绝对路径。配置中的凭证只能引用环境变量。");
        if (path === undefined) continue;
        if (!isAbsolute(path)) throw new AssistantError("INVALID_CONFIG", "请输入绝对路径。");
        let value: unknown;
        try { value = JSON.parse(await readFile(path, "utf8")); }
        catch { throw new AssistantError("INVALID_CONFIG", "无法读取配置 JSON 文件，或文件格式无效。请检查路径和 JSON 格式。"); }
        draft = parseConfig(value);
        screen.notify("配置已读入草稿，但尚未保存。请选择「保存配置」。");
      } else if (action === "save") {
        if (!draft.model) { screen.notify("请先选择模型，再保存配置。"); continue; }
        requireModel(await selectedModels(), draft.model);
        const confirmation = await screen.choose(configurationSummary(draft), [
          { value: "back", label: "返回修改" }, { value: "save", label: "确认保存" },
        ]);
        if (confirmation !== "save") continue;
        await save(parseConfig(draft));
        screen.notify("配置已保存。如需让已在运行的会话使用新配置，请重新启动应用。");
        return draft;
      }
    } catch (error) { screen.notify(userError(error)); }
  }
}

export async function initialConfiguration(current: ApplicationConfig, models: Models, directory: string): Promise<ApplicationConfig | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new AssistantError("CONFIGURE_NEEDS_TTY", "配置向导需要交互终端。在脚本中请使用 --configure-file <绝对路径>。");
  const screen = new AssistantScreen();
  screen.setHeader("4-FIRE · 应用配置");
  screen.setTranscript("如需登录，请先选择「登录模型提供商」。\n选择模型后，选择「保存配置」。\n在工作区初始化对话中提供数据服务资料。交易服务为可选项。\n按 ↑↓ 选择，按 Enter 确认。输入文字可筛选选项。按 Esc 返回。\n配置输入和登录凭证不会发送到对话。");
  screen.onQuit = () => screen.stop();
  const interrupt = () => screen.stop();
  process.on("SIGINT", interrupt);
  try {
    screen.start();
    return await configureApplication(screen, current, models, config => writeConfig(directory, config));
  } finally { process.off("SIGINT", interrupt); screen.stop(); }
}

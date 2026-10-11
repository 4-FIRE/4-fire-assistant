import type { Models } from "@earendil-works/pi-ai";
import type { ApplicationConfig } from "./application-config.js";
import { AssistantError, type ModelSelection, type AuthenticationInteraction } from "../application/ports.js";

export async function createModelRuntime(config: ApplicationConfig) {
  // Public SDK only. No coding session, ExtensionAPI or project context loader.
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  try {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false,
      ...(config.authPath ? { authPath: config.authPath } : {}),
      ...(config.modelsPath ? { modelsPath: config.modelsPath } : {}),
    });
    if (runtime.getError()) throw new Error("Model configuration failed");
    return runtime;
  } catch { throw new AssistantError("MODEL_CONFIGURATION_FAILED", "Pi 模型配置或认证配置不可用。原配置已保留。详细错误不会发送到对话。"); }
}
export async function loginModel(models: Awaited<ReturnType<typeof createModelRuntime>>, provider: string, type: "api_key" | "oauth", interaction: AuthenticationInteraction): Promise<void> {
  try {
    await models.login(provider, type, { signal: interaction.signal,
      prompt: prompt => interaction.ask(prompt.message, prompt.type === "secret" || prompt.type === "manual_code",
        prompt.type === "select" ? prompt.options : undefined, prompt.signal),
      notify: event => interaction.notify(event.type === "auth_url" ? `${event.url}\\n${event.instructions ?? ""}` :
        event.type === "device_code" ? `${event.verificationUri}\\n设备代码：${event.userCode}` :
        `${event.message}${event.type === "info" ? (event.links ?? []).map(link => `\\n${link.url}`).join("") : ""}`),
    }, { agentName: "4-fire-assistant" });
  } catch { throw new AssistantError("LOGIN_FAILED", "登录未完成，或认证存储同步失败。请检查 Pi 认证状态。程序未记录凭证，也未退出已有登录。"); }
}
export function requireModel(models: Models, selection: ModelSelection): void {
  if (!models.getModel(selection.provider, selection.modelId)) {
    throw new AssistantError("MODEL_UNAVAILABLE", "所选模型不可用。请重新选择已配置的模型。");
  }
}

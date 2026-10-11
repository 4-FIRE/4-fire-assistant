#!/usr/bin/env node
import { Research, installResearchRuntime } from "./infrastructure/research.js";
import { ResourceSnapshot, seedWorkspaceDocuments } from "./infrastructure/resources.js";
import { WorkspaceServices } from "./infrastructure/workspace-services.js";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { AssistantError, type ModelSelection, type RuntimePort } from "./application/ports.js";

import { WorkspaceMemory } from "./infrastructure/workspace-memory.js";
import { dataDirectory, machineConfigDirectory, parseConfig, parseModel, readConfig, writeConfig } from "./infrastructure/application-config.js";
import { locateWorkspace } from "./infrastructure/workspace.js";
import { confirmWorkspaceCreation } from "./interfaces/workspace.js";
import { DurableRuntime } from "./infrastructure/durable-runtime.js";
import { createModelRuntime, loginModel, requireModel } from "./infrastructure/model-runtime.js";
import { openApplicationStorage, type ApplicationStorage } from "./infrastructure/storage.js";
import { TerminalAdapter, CommittedRenderer, userError, terminalText } from "./interfaces/terminal.js";
import { TerminalApproval } from "./interfaces/approval.js";
import { terminalAuthentication } from "./interfaces/authentication.js";
import { configureApplication, initialConfiguration } from "./interfaces/configuration.js";

const CLI_OPTIONS = {
  "data-dir": { type: "string" }, model: { type: "string" },
  prompt: { type: "string" }, continue: { type: "boolean" }, help: { type: "boolean" },
  version: { type: "boolean" }, "auth-file": { type: "string" }, "models-file": { type: "string" },
  "setup-compute": { type: "boolean" }, "compute-status": { type: "boolean" },
  configure: { type: "boolean" }, "configure-file": { type: "string" }, login: { type: "string" }, "login-type": { type: "string" }, "list-models": { type: "boolean" },
} as const;
const HELP = `ffa [--data-dir ABSOLUTE_PATH] [--model provider/modelId]
当前目录为工作区。首次使用时，请先确认创建工作区，再通过对话完成初始化。
方括号表示可选参数。PATH 表示绝对路径。输入时不要包含括号。
  --data-dir PATH        指定独立配置、登录或模型列表命令使用的配置目录
  --model provider/modelId  指定模型提供商和模型 ID
  --prompt TEXT          处理一个请求后退出。不会自动恢复旧请求
  --continue             确认恢复上次未完成的请求，处理后退出
  --configure            打开交互配置向导，关闭向导后退出
  --configure-file PATH  检查并保存应用配置后退出。凭证只能引用环境变量
  --login PROVIDER       登录模型提供商。使用 Pi 认证存储，需要交互终端
  --login-type TYPE      选择 api_key（默认）或 oauth。不会自动退出已有登录
  --list-models          列出可用模型后退出。不会选择默认模型
  --auth-file PATH       指定 Pi 认证文件
  --models-file PATH     指定 Pi 模型配置文件
  --setup-compute        安装指定版本的 Python 计算依赖。需要网络连接
  --compute-status       检查共享 Python 计算环境
  --help                 显示帮助后退出
  --version              显示版本后退出
在对话中输入 /help 查看全部命令、参数和快捷键。
使用 /resolve <ID> <VERSION> <核对依据> 人工结案结果不明的交易。此命令不执行或重发交易。
模型自主组织研究。分析不等于交易许可。真实交易需要独立复核和用户确认。`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS }>>;
  try { parsed = parseArgs({ args, options: CLI_OPTIONS, strict: true, allowPositionals: false }); }
  catch { throw new AssistantError("INVALID_ARGUMENTS", "参数无效。请用 --help 查看用法。"); }
  const { values } = parsed;
  if (values.help) { process.stdout.write(HELP + "\n"); return; }
  if (values.version) {
    const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(metadata.version + "\n"); return;
  }
  if (values["setup-compute"] || values["compute-status"]) {
    if (values["setup-compute"] && values["compute-status"] || values.prompt || values.continue || values.configure || values["configure-file"] || values.login || values["data-dir"]) {
      throw new AssistantError("INVALID_ARGUMENTS", "计算环境命令不能与运行命令混用。");
    }
    const config = await readConfig(machineConfigDirectory());
    const runtimeDirectory = join(dataDirectory(), "runtimes", "compute-0.2.0");
    if (values["setup-compute"]) {
      await installResearchRuntime(runtimeDirectory, config.research?.python);
      process.stdout.write("共享 Python 环境已安装。\n");
    } else process.stdout.write(JSON.stringify(await new Research(process.cwd(), { runtimeDirectory }).status(), null, 2) + "\n");
    return;
  }
  const standalone = [values.configure === true, values["configure-file"] !== undefined, values.login !== undefined, values["list-models"] === true].filter(Boolean).length;
  if (standalone > 1 || standalone && (values.prompt !== undefined || values.continue) || values["login-type"] && !values.login ||
      values.prompt !== undefined && values.continue) throw new AssistantError("INVALID_ARGUMENTS", "配置、登录、模型列表和运行请求不能同时使用。--prompt 和 --continue 不能同时使用。");
  if (values["login-type"] && !["api_key", "oauth"].includes(values["login-type"])) throw new AssistantError("INVALID_ARGUMENTS", "请将 --login-type 设为 api_key 或 oauth。");
  for (const path of [values["auth-file"], values["models-file"]]) {
    if (path !== undefined && !isAbsolute(path)) throw new AssistantError("INVALID_CONFIG", "认证文件和模型配置文件必须使用绝对路径。");
  }
  if (values["data-dir"] && !standalone) throw new AssistantError("INVALID_ARGUMENTS", "运行助手时，当前目录为工作区。此时不能使用 --data-dir。");
  const configDirectory = values["data-dir"] ? dataDirectory({ override: values["data-dir"] }) : machineConfigDirectory();
  const workspaceDirectory = !standalone ? await locateWorkspace(process.cwd(), confirmWorkspaceCreation) : undefined;
  if (!standalone && !workspaceDirectory) return;
  const directory = workspaceDirectory?.directory ?? configDirectory;
  const workspaceRoot = workspaceDirectory?.root ?? process.cwd();
  let storage: ApplicationStorage | undefined;
  let application: RuntimePort | undefined;
  let services: WorkspaceServices | undefined;
  let terminal: TerminalAdapter | undefined;
  const notify = (message: string) => {
    if (terminal) terminal.notify(message);
    else process.stderr.write(terminalText(message) + "\n");
  };
  try {
    if (values["configure-file"]) {
      if (!isAbsolute(values["configure-file"])) throw new AssistantError("INVALID_CONFIG", "配置文件路径必须为绝对路径。");
      let source: unknown;
      try { source = JSON.parse(await readFile(values["configure-file"], "utf8")); }
      catch { throw new AssistantError("INVALID_CONFIG", "无法读取配置 JSON 文件，或文件格式无效。原配置未修改。"); }
      await writeConfig(configDirectory, parseConfig(source));
      process.stdout.write("应用配置已检查并保存。下次启动时生效。\n"); return;
    }
    let config = await readConfig(configDirectory);
    if (values["auth-file"]) config.authPath = values["auth-file"];
    if (values["models-file"]) config.modelsPath = values["models-file"];
    parseConfig(config);
    if (values.configure && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new AssistantError("CONFIGURE_NEEDS_TTY", "配置向导需要交互终端。在脚本中请使用 --configure-file <绝对路径>。");
    if (!values.login && !values["list-models"] && !values.model && !config.model && !process.stdin.isTTY) {
      throw new AssistantError("MODEL_REQUIRED", "非交互模式需要模型配置。请使用 --model 指定模型，或先保存模型配置。");
    }
    let models = await createModelRuntime(config);
    if (values.login) {
      const interaction = terminalAuthentication();
      try { await loginModel(models, values.login, values["login-type"] === "oauth" ? "oauth" : "api_key", interaction); }
      finally { interaction.dispose(); }
      process.stdout.write("登录已完成。凭证保存在 Pi 认证存储中，未发送到对话。\n"); return;
    }
    if (values["list-models"]) {
      for (const model of await models.getAvailable()) process.stdout.write(terminalText(`${model.provider}/${model.id}`) + "\n");
      return;
    }
    if (values.configure || !values.model && !config.model) {
      const configured = await initialConfiguration(config, models, configDirectory);
      if (!configured || values.configure) return;
      config = configured;
      models = await createModelRuntime(config);
    }
    const selection: ModelSelection = values.model ? parseModel(values.model) : config.model!;
    requireModel(models, selection);
    storage = await openApplicationStorage(directory);
    await seedWorkspaceDocuments(workspaceRoot);
    const memory = new WorkspaceMemory(workspaceRoot);
    const approval = new TerminalApproval(notify);
    const confirmAction = approval.confirmAction.bind(approval);
    services = await WorkspaceServices.open(directory, confirmAction);
    const research = new Research(workspaceRoot, { runtimeDirectory: join(dataDirectory(), "runtimes", "compute-0.2.0") });
    const runtime = await DurableRuntime.open({ directory: storage.directory, storage, models, model: selection,
      business: { workingDirectory: workspaceRoot, trading: services, services, confirmAction, resources: await ResourceSnapshot.load(workspaceRoot, services.extensions), research, memory, approval, emergency: notify, ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}) },
      ...(config.runtime ? { settings: {
        stream: { ...(config.runtime.modelTimeoutMs ? { timeoutMs: config.runtime.modelTimeoutMs } : {}) },
        retry: { ...(config.runtime.generationRetries !== undefined ? { maxRetries: config.runtime.generationRetries } : {}) },
        ...(config.runtime.progressIntervalMs ? { progress: { partialIntervalMs: config.runtime.progressIntervalMs, outputIntervalMs: config.runtime.progressIntervalMs } } : {}),
      } } : {}),
    });
    application = runtime;
    await writeConfig(configDirectory, { ...config, model: selection });
    terminal = new TerminalAdapter(application, process.stdin, process.stdout, approval, {
      model: `${selection.provider}/${selection.modelId}`,
      initializing: () => !services!.initialized,
      configure: async screen => {
        const resumeInput = screen.suspendInput();
        try {
          await configureApplication(screen, config, await createModelRuntime(config), async next => {
            await writeConfig(configDirectory, next);
            config = next;
          });
        } finally { resumeInput(); }
      },
    });
    if ((values.prompt !== undefined || values.continue) && process.stdin.isTTY) {
      await terminal.run(async () => {
        const result = values.continue ? await application!.continueWork() : await application!.submit(values.prompt!);
        if (result.status !== "answered") process.exitCode = 1;
      });
    } else if (values.prompt !== undefined || values.continue) {
      const renderer = new CommittedRenderer(text => { process.stdout.write(text); });
      const stop = await application.observe(view => renderer.render(view));
      const cancel = () => { void application!.cancel().catch(error => process.stderr.write(userError(error) + "\n")); };
      process.on("SIGINT", cancel);
      try {
        const result = values.continue ? await application.continueWork() : await application.submit(values.prompt!);
        if (result.status !== "answered") process.exitCode = 1;
      } finally { process.off("SIGINT", cancel); await stop(); }
    } else await terminal.run();
  } finally {
    if (application) await application.close();
    await services?.close();
    await storage?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch(error => { process.stderr.write(userError(error) + "\n"); process.exitCode = 1; }).then(() => {
    // main() has awaited cleanup. Flush output before ending the executable;
    // residual SDK handles must not keep an idle CLI alive. Imported main() never exits its host.
    process.stdout.write("", () => {
      process.stderr.write("", () => { process.exit(process.exitCode ?? 0); });
    });
  });
}

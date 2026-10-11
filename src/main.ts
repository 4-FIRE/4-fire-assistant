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
import { TerminalAdapter, CommittedRenderer, chooseSession, userError, terminalText } from "./interfaces/terminal.js";
import { TerminalApproval } from "./interfaces/approval.js";
import { terminalAuthentication } from "./interfaces/authentication.js";
import { configureApplication, initialConfiguration } from "./interfaces/configuration.js";

const CLI_OPTIONS = {
  "data-dir": { type: "string" }, model: { type: "string" },
  print: { type: "boolean", short: "p" },
  resume: { type: "boolean", short: "r" }, session: { type: "string" }, help: { type: "boolean", short: "h" },
  "list-sessions": { type: "boolean" }, "upgrade-workspace": { type: "boolean" },
  version: { type: "boolean" }, "auth-file": { type: "string" }, "models-file": { type: "string" },
  "setup-compute": { type: "boolean" }, "compute-status": { type: "boolean" },
  configure: { type: "boolean" }, "configure-file": { type: "string" }, login: { type: "string" }, "login-type": { type: "string" }, "list-models": { type: "boolean" },
} as const;
const HELP = `ffa [options] [--] [TEXT...]
默认启动新会话。TEXT 为初始请求；交互模式处理后继续等待输入。
当前目录为工作区。首次使用时，请先确认创建工作区，再通过对话完成初始化。
方括号表示可选参数。PATH 表示绝对路径。输入时不要包含括号。
  --data-dir PATH        指定独立配置、登录或模型列表命令使用的配置目录
  --model provider/modelId  指定模型提供商和模型 ID
  -p, --print            处理请求后输出并退出
  -r, --resume           打开历史会话选择器（需要交互终端）
  --session ID           打开指定会话（UUID）
  --list-sessions        列出当前工作区的会话
  --upgrade-workspace    升级当前工作区状态
  --configure            打开交互配置向导
  --configure-file PATH  检查并保存应用配置（凭证只能引用环境变量）
  --login PROVIDER       登录模型提供商（使用 Pi 认证存储，需要交互终端）
  --login-type TYPE      选择 api_key（默认）或 oauth
  --list-models          列出可用模型
  --auth-file PATH       指定 Pi 认证文件
  --models-file PATH     指定 Pi 模型配置文件
  --setup-compute        安装指定版本的 Python 计算依赖
  --compute-status       检查共享 Python 计算环境
  -h, --help             显示帮助后退出
  --version              显示版本后退出
在对话中输入 /help 查看全部命令、参数和快捷键。
使用 /resolve <ID> <VERSION> <核对依据> 人工结案结果不明的交易。此命令不执行或重发交易。
模型自主组织研究。分析不等于交易许可。真实交易需要独立复核和用户确认。`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>>;
  try { parsed = parseArgs({ args, options: CLI_OPTIONS, strict: true, allowPositionals: true }); }
  catch { throw new AssistantError("INVALID_ARGUMENTS", "参数无效。请用 --help 查看用法。"); }
  const { values, positionals } = parsed;
  const prompt = positionals.length ? positionals.join(" ") : undefined;
  const sessionOptions = [values.resume === true, values.session !== undefined].filter(Boolean).length;
  const running = prompt !== undefined || values.print || sessionOptions > 0;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !values.print;
  if (values.help) { process.stdout.write(HELP + "\n"); return; }
  if (values.version) {
    const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(metadata.version + "\n"); return;
  }
  if (values["setup-compute"] || values["compute-status"]) {
    if (values["setup-compute"] && values["compute-status"] || running || values.configure || values["configure-file"] || values.login || values["list-models"] || values["data-dir"] || values["list-sessions"] || values["upgrade-workspace"]) {
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
  if (values["upgrade-workspace"] && (standalone || running || values["list-sessions"])) {
    throw new AssistantError("INVALID_ARGUMENTS", "--upgrade-workspace 不能与配置、登录、查询或运行请求混用。");
  }
  if (values["list-sessions"] && (standalone || running)) {
    throw new AssistantError("INVALID_ARGUMENTS", "--list-sessions 不能与配置、登录、模型列表或运行请求混用。");
  }
  if (standalone > 1 || standalone && running || values["login-type"] && !values.login || sessionOptions > 1) {
    throw new AssistantError("INVALID_ARGUMENTS", "配置、登录、模型列表和运行请求不能同时使用。--resume 和 --session 只能选一个。");
  }
  if (values.resume && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new AssistantError("RESUME_NEEDS_TTY", "会话选择器需要交互终端。请用 --session <ID> 选择会话。");
  }
  if (values.session !== undefined && !values.session.trim()) throw new AssistantError("INVALID_ARGUMENTS", "--session 需要会话 ID。");
  if (values["login-type"] && !["api_key", "oauth"].includes(values["login-type"])) throw new AssistantError("INVALID_ARGUMENTS", "请将 --login-type 设为 api_key 或 oauth。");
  for (const path of [values["auth-file"], values["models-file"]]) {
    if (path !== undefined && !isAbsolute(path)) throw new AssistantError("INVALID_CONFIG", "认证文件和模型配置文件必须使用绝对路径。");
  }
  if (values["data-dir"] && !standalone) throw new AssistantError("INVALID_ARGUMENTS", "运行助手时，当前目录为工作区。此时不能使用 --data-dir。");
  const configDirectory = values["data-dir"] ? dataDirectory({ override: values["data-dir"] }) : machineConfigDirectory();
  const workspaceDirectory = !standalone ? await locateWorkspace(process.cwd(), values["upgrade-workspace"] ? async () => {
    throw new AssistantError("WORKSPACE_REQUIRED", "当前目录没有 FFA 工作区。升级命令不创建工作区。");
  } : confirmWorkspaceCreation) : undefined;
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
    if (values["upgrade-workspace"]) {
      storage = await openApplicationStorage(directory);
      process.stdout.write(JSON.stringify(await DurableRuntime.upgradeWorkspace(storage)) + "\n");
      return;
    }
    if (values["list-sessions"]) {
      storage = await openApplicationStorage(directory);
      process.stdout.write(JSON.stringify(await DurableRuntime.listSessions(storage), null, 2) + "\n");
      return;
    }
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
    let startupSession: "new" | { id: string } = values.session ? { id: values.session } : "new";
    if (values.resume) {
      const sessions = await DurableRuntime.listSessions(storage);
      // The read session closes SQLite. Release its instance lock before reopening.
      await storage.close();
      storage = await openApplicationStorage(directory);
      const id = await chooseSession(sessions);
      if (!id) return;
      startupSession = { id };
    }
    await seedWorkspaceDocuments(workspaceRoot);
    const memory = new WorkspaceMemory(workspaceRoot);
    const approval = new TerminalApproval(notify);
    const confirmAction = approval.confirmAction.bind(approval);
    services = await WorkspaceServices.open(directory, confirmAction);
    const research = new Research(workspaceRoot, { runtimeDirectory: join(dataDirectory(), "runtimes", "compute-0.2.0") });
    const runtime = await DurableRuntime.open({ directory: storage.directory, storage, models, model: selection, session: startupSession,
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
      model: `${selection.provider}/${selection.modelId}`, print: !interactive,
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
    if (interactive) await terminal.run(prompt);
    else {
      const status = await application.status();
      if (status.needsContinuation) {
        throw new AssistantError("RECOVERY_NEEDS_TTY", `会话 ${status.conversation.id} 有未完成任务：${status.work?.content ?? status.work?.requestId}。请在交互终端打开该会话，确认恢复或取消。新请求未提交。`);
      }
      let content = prompt;
      if (content === undefined && !process.stdin.isTTY) {
        process.stdin.setEncoding("utf8");
        content = "";
        for await (const chunk of process.stdin) content += chunk;
      }
      if (!content?.trim()) throw new AssistantError("EMPTY_INPUT", "非交互模式需要请求。请提供 TEXT 或通过标准输入提供内容。");
      const submit = async () => {
        const result = await application!.submit(content);
        if (result.status !== "answered") process.exitCode = 1;
      };
      if (process.stdin.isTTY && process.stdout.isTTY) await terminal.runOnce(submit);
      else {
        const renderer = new CommittedRenderer(text => { process.stdout.write(text); }, true);
        const stop = await application.observe(view => renderer.render(view));
        const cancel = () => { void application!.cancel().catch(error => process.stderr.write(userError(error) + "\n")); };
        process.on("SIGINT", cancel);
        try { await submit(); }
        finally { process.off("SIGINT", cancel); await stop(); }
      }
    }
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

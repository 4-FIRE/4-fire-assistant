import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireThat } from "../common/validation.js";
import { safePath } from "../common/files.js";
import { resourceRoot } from "../common/paths.js";
import { begin, state, saveReady } from "../storage/workspace-state.js";
import { WorkspaceState } from "../model/workspace.js";
import { canonical } from "../common/json.js";
import { providerData } from "./provider-config.js";
import type { ProviderRegistry } from "./provider-registry.js";

export const directories = ["areas", "projects", "knowledge", "providers", "scratch", "agents"];
export async function prepareWorkspace(root: string) {
  for (const part of directories) {
    const path = join(root, part);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    requireThat((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(), "工作区目录不能使用符号链接：" + path);
  }
  const agents = await readFile(join(resourceRoot, "templates/workspace-agents.md"), "utf8");
  await writeFile(join(root, "AGENTS.md"), agents, { flag: "wx" })
    .catch(error => { if (error.code !== "EEXIST") throw error; });
}
export async function documentsReady(root: string) {
  const path = await safePath(root, "AGENTS.md");
  requireThat((await readFile(path, "utf8")).trim(), "请补齐资料：AGENTS.md");
}
export async function finish(root: string, market?: string) {
  requireThat(market === undefined || typeof market === "string" && market.trim().length > 0 && market.length <= 256, "目标市场如填写须为有效非空文本；不涉及目标市场时可省略。");
  requireThat((await state(root))?.status === "pending", "工作区不处于初始化状态。");
  await saveReady(root, market);
}

export class InitializationService {
  constructor(private readonly root: string, private current: WorkspaceState, private readonly providers: ProviderRegistry) {}
  snapshot() { return new WorkspaceState({ ...this.current }); }
  private approvalData() {
    return { providers: this.providers.list().map(providerData), permissions: this.providers.permissions.read() };
  }
  async complete(input: { market?: string }, confirm: (value: unknown) => Promise<boolean>, signal: AbortSignal) {
    signal.throwIfAborted();
    requireThat(this.current.status === "pending", "工作区不处于初始化状态。");
    const market = input.market;
    if (!this.providers.list().length) await this.providers.permissions.initialize();
    const approval = this.approvalData();
    await prepareWorkspace(this.root);
    await documentsReady(this.root);
    requireThat(await confirm({ root: this.root, ...(market === undefined ? {} : { market }), ...approval }), "用户未确认完成。");
    signal.throwIfAborted();
    requireThat(canonical(approval) === canonical(this.approvalData()), "确认期间能力提供方或权限已变化，请重新确认。");
    await documentsReady(this.root);
    signal.throwIfAborted(); await finish(this.root, market);
    this.current = new WorkspaceState({ format: "ffa-pi/1", status: "ready", ...(market === undefined ? {} : { market }) });
  }
}
export async function startInitialization(root: string, confirm: (value: { root: string }, continuing: boolean) => Promise<boolean>) {
  const current = await state(root);
  requireThat(await confirm({ root }, !!current), "用户未开启初始化。");
  const initial = await begin(root);
  await prepareWorkspace(root);
  return initial;
}

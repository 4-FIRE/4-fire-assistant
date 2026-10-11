import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireThat } from "../common/validation.js";
import { safePath } from "../common/files.js";
import { resourceRoot } from "../common/paths.js";
import { begin, state, saveReady } from "../storage/workspace-state.js";
import { WorkspaceState } from "../model/workspace.js";
import type { Receipt } from "../model/receipt.js";
import type { Store } from "../storage/store.js";
import type { SourceService } from "./source-service.js";

export const directories = ["areas", "projects", "knowledge", "sources", "scratch"];
export async function prepareDirectories(root: string) {
  for (const part of directories) {
    const path = join(root, part);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    requireThat((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(), "投资目录不能使用符号链接：" + path);
  }
}
export async function documentsReady(root: string, sources: string[]) {
  for (const path of ["AGENTS.md", "sources/AGENTS.md", ...sources.map(id => "sources/" + id + "/GUIDE.md")]) {
    const full = await safePath(root, path);
    requireThat((await readFile(full, "utf8")).trim(), "请补齐资料：" + path);
  }
}
export async function finish(root: string, market: string) {
  requireThat(market.trim().length > 0 && market.length <= 256, "需要有效的目标市场。");
  requireThat((await state(root))?.status === "pending", "工作区不处于初始化状态。");
  await saveReady(root, market);
}

export class InitializationService {
  constructor(private readonly root: string, private current: WorkspaceState, private readonly store: Store,
    private readonly sources: SourceService) {}
  snapshot() { return new WorkspaceState({ ...this.current }); }
  private checkCatalog() {
    for (const source of this.sources.list()) {
      requireThat(source.kind === "mcp" ? source.discovery?.status === "complete" : source.coverage?.basis.trim(), "请补齐来源发现或 CLI 资料依据。");
      requireThat(source.operations.every(op => op.available === false || op.assessment !== "unassessed"), "还有未经分析的能力。请逐项分析；无法确定时记录依据并标记 uncertain。");
    }
  }
  async complete(input: { market: string; quote: string; history: string },
    confirm: (value: unknown) => Promise<boolean>, signal: AbortSignal) {
    requireThat(this.current.status === "pending" && input.quote !== input.history, "需要两个独立查询回执。");
    const receipts = [input.quote, input.history].map(id => this.store.get<Receipt>("receipt", id));
    for (const receipt of receipts) {
      requireThat(receipt?.success, "需要成功的真实查询回执。");
      requireThat(receipt.binding === await this.sources.binding(receipt.source, receipt.operation, signal), "查询来源已变化，请重新验证。");
    }
    this.checkCatalog();
    await prepareDirectories(this.root);
    const agents = await readFile(join(resourceRoot, "templates/workspace-agents.md"), "utf8");
    await writeFile(join(this.root, "AGENTS.md"), agents, { flag: "wx" })
      .catch(error => { if (error.code !== "EEXIST") throw error; });
    await documentsReady(this.root, [...new Set(receipts.map(receipt => receipt!.source))]);
    requireThat(await confirm({ root: this.root, market: input.market, quote: receipts[0], history: receipts[1] }), "用户未确认完成。");
    signal.throwIfAborted();
    for (const receipt of receipts) requireThat(receipt!.binding === await this.sources.binding(receipt!.source, receipt!.operation, signal), "确认期间来源变化，请重新验证。");
    this.checkCatalog();
    signal.throwIfAborted(); await finish(this.root, input.market);
    this.current = new WorkspaceState({ format: "ffa-pi/2", status: "ready", market: input.market });
  }
}
export async function startInitialization(root: string, confirm: (value: unknown, continuing: boolean) => Promise<boolean>) {
  const current = await state(root);
  requireThat(await confirm({ root }, !!current), "用户未开启初始化。");
  return begin(root);
}

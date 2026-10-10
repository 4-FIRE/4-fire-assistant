import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AssistantError } from "../application/ports.js";
import { canonical, type Json } from "../domain/shared.js";
import type { WorkspaceConfig } from "../domain/workspace.js";
import { parseConfig, readConfig, writeConfig } from "./config.js";
import { parseToolContract } from "./tool-contracts.js";
import { parseWorkspace, saveWorkspace } from "./workspace.js";

/** Only called after terminal confirmation. The final workspace marker publishes the enabled set. */
export async function saveInitialization(directory: string, machineDirectory: string, workspace: WorkspaceConfig): Promise<void> {
  workspace = parseWorkspace(workspace);
  if (workspace.initialization !== "complete") { await saveWorkspace(directory, workspace); return; }
  const machine = await readConfig(machineDirectory);
  const sources = { ...machine.sources };
  const contracts = [];
  const seen = new Set<string>();
  for (const draft of workspace.draft.sources) {
    if (!draft.id || !draft.connection || !draft.operations?.length) continue;
    if (seen.has(draft.id)) throw new AssistantError("SOURCE_ID_CONFLICT", "接入草案存在重复来源标识，请修改后确认。");
    seen.add(draft.id);
    const contract = parseToolContract({ version: 1, sourceId: draft.id, operations: draft.operations });
    const connection = parseConfig({ version: 1, sources: { [draft.id]: draft.connection } }).sources![draft.id]!;
    const previous = Object.hasOwn(sources, draft.id) ? sources[draft.id] : undefined;
    if (previous && canonical(previous as unknown as Json) !== canonical(connection as unknown as Json)) {
      throw new AssistantError("SOURCE_ID_CONFLICT", "本机已有同名但不同的连接；请使用新的来源标识，避免影响其他工作区。");
    }
    if (connection.transport === "cli" && contract.operations.some(op => !op.argv)) throw new AssistantError("CLI_BINDING_REQUIRED", "CLI 操作缺少明确的 argv 绑定；请补充或暂不启用。");
    sources[draft.id] = connection;
    contracts.push(contract);
  }
  // Connection material alone grants no workspace permission.
  if (contracts.length) {
    await writeConfig(machineDirectory, { ...machine, sources });
    const toolsDirectory = join(directory, "tools");
    await mkdir(toolsDirectory, { recursive: true, mode: 0o700 });
    for (const contract of contracts) {
      const temporary = join(toolsDirectory, `.contract-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(contract, null, 2) + "\n"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(toolsDirectory, `${contract.sourceId}.json`));
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    }
    const parent = await open(toolsDirectory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  await saveWorkspace(directory, { ...workspace, enabledSources: contracts.map(contract => contract.sourceId) });
}

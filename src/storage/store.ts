import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceOwner } from "./workspace-owner.js";
import { FileAccess } from "./file-access.js";
import { CallFiles } from "./call-files.js";
import { SettingsFile } from "./settings-file.js";
import { ProviderFiles } from "./provider-files.js";
import { initializeFileStorage } from "./initialize-storage.js";
import { readJsonFile } from "./atomic-json.js";
import { parseState } from "./workspace-state.js";

/** One workspace owner and one file data source. */
export class Store {
  readonly #owner: WorkspaceOwner;
  readonly #files: FileAccess;
  readonly calls: CallFiles;
  readonly settings: SettingsFile;
  readonly providers: ProviderFiles;
  constructor(readonly directory: string, create = true) {
    const workspace = existsSync(join(directory, "workspace.json"));
    if (workspace) readJsonFile(directory, "workspace.json", parseState);
    this.#owner = new WorkspaceOwner(directory);
    this.#files = new FileAccess(directory);
    try {
      if (workspace) readJsonFile(directory, "workspace.json", parseState);
      if (create && !existsSync(join(directory, "settings.json"))) initializeFileStorage(directory);
      this.calls = new CallFiles(this.#files);
      this.settings = new SettingsFile(this.#files);
      this.providers = new ProviderFiles(this.#files);
    } catch (error) { this.close(); throw error; }
  }
  get healthy() { return this.#files.healthy; }
  close() { this.#files.close(); this.#owner.close(); }
}

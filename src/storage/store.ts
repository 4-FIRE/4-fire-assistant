import { existsSync } from "node:fs";
import { join } from "node:path";
import { FileAccess } from "./file-access.js";
import { CallFiles } from "./call-files.js";
import { parseSettings } from "./settings-file.js";
import { ProviderFiles } from "./provider-files.js";
import { initializeFileStorage } from "./initialize-storage.js";
import { readJsonFile } from "./atomic-json.js";
import { parseState } from "./workspace-state.js";

/** Workspace file data source with instance-scoped write health. */
export class Store {
  readonly #files: FileAccess;
  readonly calls: CallFiles;
  readonly providers: ProviderFiles;
  constructor(readonly directory: string, create = true) {
    const workspace = existsSync(join(directory, "workspace.json"));
    if (workspace) readJsonFile(directory, "workspace.json", parseState);
    this.#files = new FileAccess(directory);
    try {
      if (create && !existsSync(join(directory, "settings.json"))) initializeFileStorage(directory);
      this.calls = new CallFiles(this.#files);
      this.#files.read("settings.json", parseSettings);
      this.providers = new ProviderFiles(this.#files);
    } catch (error) { this.close(); throw error; }
  }
  get healthy() { return this.#files.healthy; }
  close() { this.#files.close(); }
}

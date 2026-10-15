import { readdirSync } from "node:fs";
import { requireThat } from "../common/validation.js";
import { writeJsonFile } from "./atomic-json.js";
import { privateDirectory } from "./file-access.js";
import { parseSettings } from "./settings-file.js";

export function initializeFileStorage(directory: string) {
  requireThat(readdirSync(directory).every(name => name === "owner.lock"),
    "已有存储不能初始化或补全；请检查状态，保留原数据。");
  privateDirectory(directory, "calls"); privateDirectory(directory, "results"); privateDirectory(directory, "providers");
  writeJsonFile(directory, "settings.json", {}, parseSettings);
}

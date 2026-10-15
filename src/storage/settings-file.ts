import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { FileAccess } from "./file-access.js";

export function parseSettings(value: unknown): { python?: string } {
  requireThat(object(value) && Object.keys(value).every(key => key === "python") &&
    (!Object.hasOwn(value, "python") || typeof value.python === "string" && value.python.startsWith("/") && !value.python.includes("\0")),
    "工作区设置无效。");
  return value;
}
export class SettingsFile {
  constructor(private readonly files: FileAccess) { this.read(); }
  read() { return this.files.read("settings.json", parseSettings); }
  save(value: { python?: string }) { this.files.write("settings.json", value, parseSettings); }
}

import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";

export function parseSettings(value: unknown): { python?: string } {
  requireThat(object(value) && Object.keys(value).every(key => key === "python") &&
    (!Object.hasOwn(value, "python") || typeof value.python === "string" && value.python.startsWith("/") && !value.python.includes("\0")),
    "工作区设置无效。");
  return value;
}

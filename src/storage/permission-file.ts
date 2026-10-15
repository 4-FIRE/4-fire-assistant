import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toolId } from "../common/tool-id.js";
import { requireThat, schema } from "../common/validation.js";
import type { Permissions } from "../model/permission.js";
import { readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";

const permission = { enum: ["allow", "ask", "review", "deny"] };
const valid = schema({ type: "object", additionalProperties: false, required: ["default", "tools"], properties: {
  default: permission, tools: { type: "object", additionalProperties: permission,
    propertyNames: { pattern: "^[a-z][a-z0-9_]{0,47}/.+$" } },
} });
function parsePermissions(value: unknown): Permissions {
  requireThat(valid(value), "权限配置无效。需要 default 和 tools，值为 allow、ask、review 或 deny。");
  const config = value as Permissions;
  for (const id of Object.keys(config.tools)) {
    const [provider, operation] = id.split("/");
    requireThat(operation && id === toolId(provider!, decodeURIComponent(operation)), "工具 ID 必须使用规范编码。");
  }
  return config;
}

export class PermissionFile {
  readonly #directory: string;
  #failed = false;
  constructor(root: string) { this.#directory = join(root, ".ffa"); }
  checkHealthy() { requireThat(!this.#failed, "权限保存未可靠完成；请重载并核对配置。"); }
  read(): Permissions {
    return readJsonFile(this.#directory, "permissions.json", parsePermissions);
  }
  async initialize() {
    this.checkHealthy();
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      syncDirectory(dirname(this.#directory));
      writeJsonFile(this.#directory, "permissions.json", { default: "ask", tools: {} }, parsePermissions, true);
    } catch (error) { this.#failed = true; throw error; }
  }
  async write(value: Permissions) {
    this.checkHealthy();
    parsePermissions(value);
    try { writeJsonFile(this.#directory, "permissions.json", value, parsePermissions); }
    catch (error) { this.#failed = true; throw error; }
  }
}

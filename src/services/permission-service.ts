import { canonical } from "../common/json.js";
import { toolId } from "../common/tool-id.js";
import { requireThat, schema } from "../common/validation.js";
import type { Permission, Permissions } from "../model/permission.js";
import { PermissionFile } from "../storage/permission-file.js";

const permission = { enum: ["allow", "ask", "review", "deny"] };
const valid = schema({ type: "object", additionalProperties: false, required: ["default", "tools"], properties: {
  default: permission, tools: { type: "object", additionalProperties: permission,
    propertyNames: { pattern: "^[a-z][a-z0-9_]{0,47}/.+$" } },
} });
export class PermissionService {
  readonly #file: PermissionFile;
  constructor(root: string) { this.#file = new PermissionFile(root); }
  read(): Permissions {
    try {
      const value: unknown = JSON.parse(this.#file.read());
      requireThat(valid(value), "权限配置无效。需要 default 和 tools，值为 allow、ask、review 或 deny。");
      const config = value as Permissions;
      for (const id of Object.keys(config.tools)) {
        const [provider, operation] = id.split("/");
        requireThat(operation && id === toolId(provider!, decodeURIComponent(operation)), "工具 ID 必须使用规范编码。");
      }
      return config;
    } catch {
      throw new Error("工具权限不可用；调用已停止，请用户检查权限设置。");
    }
  }
  get(provider: string, operation: string): Permission {
    const config = this.read(), id = toolId(provider, operation);
    return Object.hasOwn(config.tools, id) ? config.tools[id]! : config.default;
  }
  plan(provider: string, names: string[], changes: Record<string, Permission | null>, mode: "suggest" | "set", current: Permissions) {
    const next = structuredClone(current), applied: Record<string, Permission | null> = {}, preserved: Record<string, Permission> = {};
    for (const [name, value] of Object.entries(changes)) {
      requireThat(names.includes(name) && (permission.enum.includes(value as string) || mode === "set" && value === null), "permissions：只能修改当前提供方已知操作的权限。");
      const id = toolId(provider, name);
      if (mode === "suggest" && Object.hasOwn(current.tools, id)) { Object.defineProperty(preserved, name, { value: current.tools[id], enumerable: true }); continue; }
      if (value === null) delete next.tools[id];
      else next.tools[id] = value;
      Object.defineProperty(applied, name, { value, enumerable: true });
    }
    return { next, applied, preserved };
  }
  async initialize() {
    try {
      await this.#file.initialize(JSON.stringify({ default: "ask", tools: {} }, null, 2) + "\n"); this.read();
    } catch {
      throw new Error("无法初始化工具权限；接入已停止。");
    }
  }
  async save(next: Permissions, expected: Permissions) {
    requireThat(canonical(this.read()) === canonical(expected), "确认期间权限配置已变化，请重新读取。");
    if (canonical(next) !== canonical(expected)) {
      await this.#file.write(JSON.stringify(next, null, 2) + "\n");
      requireThat(canonical(this.read()) === canonical(next), "权限写入后状态已变化。");
    }
  }
}

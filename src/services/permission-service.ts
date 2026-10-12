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
  #current: string | undefined;
  constructor(root: string, private readonly invalidate: () => void) { this.#file = new PermissionFile(root); }
  read(): Permissions {
    try {
      const value: unknown = JSON.parse(this.#file.read());
      requireThat(valid(value), "权限配置无效。需要 default 和 tools，值为 allow、ask、review 或 deny。");
      const config = value as Permissions;
      for (const id of Object.keys(config.tools)) {
        const [provider, operation] = id.split("/");
        requireThat(operation && id === toolId(provider!, decodeURIComponent(operation)), "工具 ID 必须使用规范编码。");
      }
      const current = canonical(config);
      if (this.#current !== undefined && current !== this.#current) this.invalidate();
      this.#current = current;
      return config;
    } catch {
      this.invalidate(); this.#current = undefined;
      throw new Error("工具权限不可用；调用已停止，请用户检查权限设置。");
    }
  }
  get(provider: string, operation: string): Permission {
    const config = this.read(), id = toolId(provider, operation);
    return Object.hasOwn(config.tools, id) ? config.tools[id]! : config.default;
  }
  proposals(provider: string, names: string[], proposed: Record<string, Permission>) {
    for (const [id, value] of Object.entries(proposed)) {
      requireThat(names.some(name => toolId(provider, name) === id) && permission.enum.includes(value), "权限建议只能包含当前能力提供方的已知工具。");
    }
    return proposed;
  }
  async initialize() {
    try {
      await this.#file.initialize(JSON.stringify({ default: "ask", tools: {} }, null, 2) + "\n"); this.read();
    } catch {
      this.invalidate(); throw new Error("无法初始化工具权限；接入已停止。");
    }
  }
  async addMissing(proposed: Record<string, Permission>, expected: Permissions) {
    const config = this.read();
    requireThat(canonical(config) === canonical(expected), "确认期间权限配置已变化，请重新配置。");
    for (const [id, value] of Object.entries(proposed)) if (!Object.hasOwn(config.tools, id)) config.tools[id] = value;
    if (canonical(config) !== canonical(expected)) {
      try {
        await this.#file.write(JSON.stringify(config, null, 2) + "\n"); this.read();
      } catch {
        this.invalidate(); throw new Error("无法保存工具权限；接入已停止。");
      }
    }
  }
}

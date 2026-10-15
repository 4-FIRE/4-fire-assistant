import { canonical } from "../../common/json.js";
import { toolId } from "../../common/tool-id.js";
import { requireThat } from "../../common/validation.js";
import type { Permission, Permissions } from "../../model/permission.js";
import { PermissionFile } from "../../storage/permission-file.js";

const permission = { enum: ["allow", "ask", "review", "deny"] };
function effective(config: Permissions, id: string): Permission {
  return Object.hasOwn(config.tools, id) ? config.tools[id]! : config.default;
}
export class PermissionService {
  readonly #file: PermissionFile;
  constructor(root: string) { this.#file = new PermissionFile(root); }
  read(): Permissions {
    try {
      return this.#file.read();
    } catch {
      throw new Error("工具权限不可用；调用已停止，请用户检查权限设置。");
    }
  }
  get(provider: string, operation: string): Permission {
    this.#file.checkHealthy();
    return effective(this.read(), toolId(provider, operation));
  }
  view(provider: string, names: string[], config = this.read()) {
    const explicit = Object.fromEntries(names.flatMap(name => {
      const id = toolId(provider, name);
      return Object.hasOwn(config.tools, id) ? [[name, config.tools[id]!]] : [];
    }));
    return { default: config.default, explicit, effective: Object.fromEntries(names.map(name =>
      [name, effective(config, toolId(provider, name))])) };
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
      await this.#file.initialize(); this.read();
    } catch {
      throw new Error("无法初始化工具权限；接入已停止。");
    }
  }
  async save(next: Permissions, expected: Permissions) {
    this.#file.checkHealthy();
    requireThat(canonical(this.read()) === canonical(expected), "确认期间权限配置已变化，请重新读取。");
    if (canonical(next) !== canonical(expected)) {
      await this.#file.write(next);
      requireThat(canonical(this.read()) === canonical(next), "权限写入后状态已变化。");
    }
  }
}

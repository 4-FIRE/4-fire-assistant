import { lstat, readdir, readFile } from "node:fs/promises";
import { builtInPermissions, type Capability } from "../application/permissions.js";
import { object } from "../domain/shared.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AssistantError } from "../application/ports.js";

export const resourceRoot = fileURLToPath(new URL("../../resources/", import.meta.url));
interface ResourceManifest { files: { path: string }[] }
function resourceManifest(): ResourceManifest {
  return JSON.parse(readFileSync(join(resourceRoot, "manifest.json"), "utf8")) as ResourceManifest;
}
export function resourceText(path: string): string {
  const file = resourceManifest().files.find(file => file.path === path);
  if (!file || !/^(prompts|references)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(md|json)$/.test(path)) {
    throw new AssistantError("RESOURCE_DENIED", "只能读取包内已登记资料，不接受文件系统路径。");
  }
  return readFileSync(join(resourceRoot, path), "utf8");
}
/** Immutable startup texts. Overrides cannot modify application permissions. */
export class ResourceSnapshot {
  readonly roles: import("../application/permissions.js").RolePermissions;
  private constructor(private readonly texts: ReadonlyMap<string, string>,
    roles: import("../application/permissions.js").RolePermissions, private readonly rolePaths: ReadonlyMap<string, string>) {
    this.roles = Object.freeze(Object.fromEntries(Object.entries(roles).map(([id, caps]) => [id, Object.freeze([...caps])])));
  }
  static defaults(): ResourceSnapshot {
    const texts = new Map(resourceManifest().files.map(file => [file.path, resourceText(file.path)]));
    return new ResourceSnapshot(texts, builtInPermissions, new Map(Object.keys(builtInPermissions).map(id => [id, `prompts/roles/${id}.md`])));
  }
  static async load(directory: string, extensions: Record<string, Record<string, string[]>> = {}): Promise<ResourceSnapshot> {
    const base = ResourceSnapshot.defaults(), texts = new Map(base.texts), paths = new Map(base.rolePaths);
    const roles: Record<string, readonly Capability[]> = { ...base.roles };
    for (const [path, value] of await snapshotFiles(join(directory, "resources"))) {
      if (!texts.has(path)) throw new AssistantError("RESOURCE_UNKNOWN", `未知覆盖资源：${path}`);
      texts.set(path, value);
    }
    if (Object.keys(extensions).length) {
      try { if ((await lstat(join(directory, "extensions"))).isSymbolicLink()) invalidExtension(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const [id, grants] of Object.entries(extensions)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !object(grants)) invalidExtension();
      let files = await snapshotFiles(join(directory, "extensions", id));
      if (!files.size) files = await snapshotFiles(join(extensionRoot, id));
      const manifest = JSON.parse(files.get("extension.json") ?? "null") as unknown;
      if (!object(manifest) || manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.roles) ||
          Object.keys(manifest).some(key => !["version", "id", "roles", "toolRequests"].includes(key))) invalidExtension();
      const requested = new Set<string>();
      for (const role of manifest.roles) {
        if (!object(role) || typeof role.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(role.id) ||
            typeof role.prompt !== "string" || !role.prompt.endsWith(".md") || !files.has(role.prompt) ||
            !Array.isArray(role.capabilities) || !role.capabilities.every(cap => ["read", "prepare", "compute"].includes(String(cap)))) invalidExtension();
        const full = `${id}/${role.id}`;
        if (requested.has(role.id) || Object.hasOwn(roles, full)) invalidExtension();
        requested.add(role.id);
        const approved = Object.hasOwn(grants, role.id) ? grants[role.id] : undefined;
        if (!approved) continue;
        if (!Array.isArray(approved) || !approved.every(cap => (role.capabilities as unknown[]).includes(cap))) invalidExtension();
        roles[full] = [...new Set(approved)] as Capability[];
        paths.set(full, `extensions/${id}/${role.prompt}`);
      }
      if (Object.keys(grants).some(role => !requested.has(role))) invalidExtension();
      for (const [path, value] of files) if (path.endsWith(".md")) texts.set(`extensions/${id}/${path}`, value);
    }
    return new ResourceSnapshot(texts, roles, paths);
  }
  promptText(group: "tools" | "runtime", key: string): string {
    const path = group === "tools" ? "prompts/tools.json" : "prompts/runtime/messages.json";
    const entries: unknown = JSON.parse(this.texts.get(path) ?? "null");
    const value = object(entries) && Object.hasOwn(entries, key) ? entries[key] : undefined;
    if (typeof value !== "string" || !value.trim()) throw new AssistantError("PROMPT_MISSING", "启动快照缺少提示词条目。");
    return value;
  }
  reference(path: string): string {
    const text = this.texts.get(path);
    if (!path.endsWith(".md") || text === undefined) throw new AssistantError("RESOURCE_DENIED", "资料不在本次启动快照内。");
    return text;
  }
  instructions(role: string): string {
    const path = this.rolePaths.get(role);
    if (!path) throw new AssistantError("ROLE_DENIED", "角色没有启用。");
    const items = [this.reference(path)];
    items.push(this.reference("prompts/runtime/contract.md"));
    return items.map(text => text.trimEnd()).join("\n\n");
  }
}

const extensionRoot = fileURLToPath(new URL("../../extensions/", import.meta.url));
function invalidExtension(): never { throw new AssistantError("EXTENSION_INVALID", "扩展清单或角色授权无效；扩展不能自行授予权限。"); }
async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    const absolute = path ? join(root, path) : root;
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if (!path && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink()) throw new AssistantError("RESOURCE_SYMLINK", "资源目录与文件不能是符号链接。");
    if (info.isDirectory()) {
      for (const entry of await readdir(absolute)) {
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(entry) || entry === "..") invalidExtension();
        await visit(path ? path + "/" + entry : entry);
      }
    } else {
      if (!info.isFile() || !/\.(md|json)$/.test(path) || info.size > 1024 * 1024 ||
          (bytes += info.size) > 8 * 1024 * 1024 || files.size >= 256) invalidExtension();
      files.set(path, await readFile(absolute, "utf8"));
    }
  }
  await visit("");
  return files;
}

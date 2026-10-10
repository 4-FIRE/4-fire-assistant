import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { builtInPermissions, type Capability, type RolePermissions } from "../application/permissions.js";
import { object } from "../domain/shared.js";
import { AssistantError } from "../application/ports.js";

export const resourceRoot = fileURLToPath(new URL("../../resources/", import.meta.url));
export function resourceText(path: string): string {
  const absolute = resolve(resourceRoot, path), local = relative(resourceRoot, absolute);
  if (local.startsWith("..") || !/\.(md|json)$/.test(local)) throw new AssistantError("RESOURCE_DENIED", "资料路径无效。");
  return readFileSync(absolute, "utf8");
}
async function optionalText(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
/** Product files live in .ffa, never overwrite the host project's AGENTS.md. */
export async function seedWorkspaceDocuments(directory: string): Promise<void> {
  for (const path of ["AGENTS.md", "BOOTSTRAP.md", "sources/AGENTS.md"]) {
    const destination = join(directory, path);
    const parent = join(destination, "..");
    await mkdir(parent, { recursive: true });
    if ((await lstat(parent)).isSymbolicLink()) throw new AssistantError("RESOURCE_SYMLINK", "工作区资料目录不能是符号链接。");
    try { await writeFile(destination, resourceText(`workspace/${path}`), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

/** Text supplies guidance; only explicit grants supply capabilities. */
export class ResourceSnapshot {
  private constructor(readonly roles: RolePermissions, private readonly prompts: ReadonlyMap<string, string>, readonly directory?: string) {}
  static defaults(): ResourceSnapshot {
    return new ResourceSnapshot(builtInPermissions, new Map(Object.keys(builtInPermissions).map(role => [role, resourceText(`prompts/roles/${role}.md`)])));
  }
  static async load(directory: string, extensions: Record<string, Record<string, string[]>> = {}): Promise<ResourceSnapshot> {
    const base = ResourceSnapshot.defaults(), prompts = new Map(base.prompts);
    const roles: Record<string, readonly Capability[]> = { ...base.roles };
    for (const role of Object.keys(roles)) {
      const override = await optionalText(join(directory, "roles", `${role}.md`));
      if (override.trim()) prompts.set(role, override);
    }
    for (const [id, grants] of Object.entries(extensions)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) invalidExtension();
      let root = join(directory, "extensions", id);
      if (!await optionalText(join(root, "extension.json"))) root = fileURLToPath(new URL(`../../extensions/${id}/`, import.meta.url));
      const manifest: unknown = JSON.parse(await readFile(join(root, "extension.json"), "utf8"));
      if (!object(manifest) || manifest.id !== id || manifest.version !== 1 || !Array.isArray(manifest.roles)) invalidExtension();
      const requested = new Set<string>();
      for (const role of manifest.roles) {
        if (!object(role) || typeof role.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(role.id) || requested.has(role.id) ||
            typeof role.prompt !== "string" || !/^[a-zA-Z0-9-]+\.md$/.test(role.prompt) || !Array.isArray(role.capabilities) ||
            role.capabilities.some(cap => typeof cap !== "string" || !["read", "prepare", "compute"].includes(cap))) invalidExtension();
        requested.add(role.id);
        const approved = grants[role.id];
        if (!approved) continue;
        if (!Array.isArray(approved) || approved.some(cap => !(role.capabilities as unknown[]).includes(cap))) invalidExtension();
        const info = await lstat(join(root, role.prompt));
        if (!info.isFile() || info.isSymbolicLink()) invalidExtension();
        roles[`${id}/${role.id}`] = Object.freeze([...new Set(approved)] as Capability[]);
        prompts.set(`${id}/${role.id}`, await readFile(join(root, role.prompt), "utf8"));
      }
      if (Object.keys(grants).some(role => !requested.has(role))) invalidExtension();
    }
    return new ResourceSnapshot(Object.freeze(roles), prompts, directory);
  }
  promptText(group: "tools" | "runtime", key: string): string {
    const entries: unknown = JSON.parse(resourceText(group === "tools" ? "prompts/tools.json" : "prompts/runtime/messages.json"));
    const value = object(entries) ? entries[key] : undefined;
    if (typeof value !== "string") throw new AssistantError("PROMPT_MISSING", "缺少工具或运行说明。");
    return value;
  }
  instructions(role: string): string {
    const prompt = this.prompts.get(role);
    if (!prompt) throw new AssistantError("ROLE_DENIED", "角色未启用。");
    return prompt + "\n\n" + resourceText("prompts/runtime/contract.md");
  }
  async context(initialized: boolean): Promise<string> {
    const bundled = loadSkillsFromDir({ dir: join(resourceRoot, "skills"), source: "bundled" });
    const local = this.directory ? loadSkillsFromDir({ dir: join(this.directory, "skills"), source: "workspace" }) : { skills: [], diagnostics: [] };
    const skills = new Map([...bundled.skills, ...local.skills].map(skill => [skill.name, skill]));
    const parts = [formatSkillsForPrompt([...skills.values()]), ...[...bundled.diagnostics, ...local.diagnostics].map(item => `技能加载提示：${item.message}`)];
    if (this.directory) {
      parts.push(`产品工作区：${this.directory}。相对文件路径以此为准。`);
      for (const name of ["AGENTS.md", "sources/AGENTS.md", "SOUL.md", ...(!initialized ? ["BOOTSTRAP.md"] : [])]) {
        const text = await optionalText(join(this.directory, name));
        if (text) parts.push(`## ${name}\n${text}`);
      }
    }
    parts.push(initialized ? "初始化已完成；按当前任务读取资料并工作。" : "初始化尚未完成；本轮只推进接入、验证和完成确认。不能跳过初始化。");
    return parts.join("\n\n");
  }
}
function invalidExtension(): never { throw new AssistantError("EXTENSION_INVALID", "扩展清单或授权无效，扩展不能自行提升权限。"); }

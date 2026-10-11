import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
export const workspaceDirectories = ["areas", "projects", "knowledge", "sources", "roles", ".agents", ".agents/skills", ".claude", "extensions", "scratch"];
const entryDocuments = ["AGENTS.md", "CLAUDE.md", "areas/AGENTS.md", "projects/AGENTS.md", "knowledge/AGENTS.md", "sources/AGENTS.md", ".agents/skills/AGENTS.md"];

/** Create missing entries only. The assistant integrates existing user documents. */
export async function seedWorkspaceDocuments(directory: string): Promise<void> {
  for (const name of workspaceDirectories) {
    const path = join(directory, name);
    // Parents precede children. Do not create children through an existing alias.
    try { await mkdir(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AssistantError("RESOURCE_SYMLINK", "工作区资料目录必须是普通目录。");
  }
  for (const path of entryDocuments) {
    const destination = join(directory, path);
    try { await writeFile(destination, resourceText(`workspace/${path}`), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  // One skill source for both harnesses. Preserve existing Claude customizations.
  try { await symlink("../.agents/skills", join(directory, ".claude", "skills")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
export async function validateWorkspaceDocuments(directory: string): Promise<void> {
  for (const path of [...workspaceDirectories, ...entryDocuments]) {
    const absolute = join(directory, path);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (workspaceDirectories.includes(path) ? !info.isDirectory() : !info.isFile())) {
        throw new AssistantError("SOURCE_GUIDE_UNREADABLE", `工作区入口必须为普通文件或目录：${absolute}`);
      }
      if (!workspaceDirectories.includes(path) && !(await readFile(absolute, "utf8")).trim()) {
        throw new AssistantError("SOURCE_GUIDE_REQUIRED", `工作区入口不能为空：${absolute}`);
      }
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AssistantError("SOURCE_GUIDE_REQUIRED", `请补齐工作区入口：${absolute}`);
      throw new AssistantError("SOURCE_GUIDE_UNREADABLE", `无法读取工作区入口：${absolute}`);
    }
  }
}

/** Text supplies guidance; only explicit grants supply capabilities. */
export class ResourceSnapshot {
  private constructor(readonly roles: RolePermissions, private readonly prompts: ReadonlyMap<string, string>,
    readonly directory?: string, private readonly grants: Record<string, Record<string, string[]>> = {},
    private readonly documents: ReadonlyMap<string, string> = new Map(), private readonly skillIndex = "") {}
  static defaults(): ResourceSnapshot {
    return new ResourceSnapshot(builtInPermissions, new Map(Object.keys(builtInPermissions).map(role => [role, resourceText(`prompts/roles/${role}.md`)])));
  }
  static async load(directory: string, extensions: Record<string, Record<string, string[]>> = {}): Promise<ResourceSnapshot> {
    const base = ResourceSnapshot.defaults(), prompts = new Map(base.prompts);
    const roles: Record<string, readonly Capability[]> = { ...base.roles };
    for (const role of Object.keys(roles)) {
      const override = await optionalText(join(directory, "roles", `${role}.md`));
      if (override.trim()) prompts.set(role, prompts.get(role) + "\n\n## 工作区角色补充\n" + override);
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
    const documents = new Map<string, string>();
    for (const name of ["AGENTS.md", "SOUL.md", "BOOTSTRAP.md"]) documents.set(name, await optionalText(join(directory, name)));
    return new ResourceSnapshot(Object.freeze(roles), prompts, directory, structuredClone(extensions), documents, skillContext(directory));
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
    return resourceText("prompts/runtime/behavior.md") + "\n\n" + prompt + "\n\n" + resourceText("prompts/runtime/contract.md");
  }
  async refresh(): Promise<ResourceSnapshot> {
    const next = this.directory ? await ResourceSnapshot.load(this.directory, this.grants) : ResourceSnapshot.defaults();
    if (JSON.stringify(next.roles) !== JSON.stringify(this.roles)) throw new AssistantError("RESOURCE_RESTART_REQUIRED", "扩展角色或能力声明已变化；请停止应用后核对配置并重启。");
    return next;
  }
  async context(initialized: boolean): Promise<string> {
    const parts = [this.directory ? this.skillIndex : skillContext()];
    if (this.directory) {
      parts.push(`投资工作区：${this.directory}。相对文件路径以此为准。.ffa 保存配置与程序状态。`);
      for (const name of ["AGENTS.md", "SOUL.md"]) {
        const text = this.documents.get(name);
        if (text) parts.push(`## ${name}\n${text}`);
      }
      const sources = await optionalText(join(this.directory, "sources", "AGENTS.md"));
      if (sources) parts.push(`## 服务资料索引（知识入口，不授予权限）\n${sources}`);
    }
    if (!initialized) {
      parts.push(resourceText("workspace/BOOTSTRAP.md"));
      const local = this.documents.get("BOOTSTRAP.md");
      if (local) parts.push(`## 工作区初始化补充\n${local}`);
    }
    parts.push(initialized ? "初始化已完成；按当前任务读取资料并工作。" : "初始化尚未完成；先整理工作区资料、接通服务并验证，最后完成确认。不能跳过初始化。");
    return parts.join("\n\n");
  }
}
function skillContext(directory?: string): string {
  const bundled = loadSkillsFromDir({ dir: join(resourceRoot, "skills"), source: "bundled" });
  const local = directory ? loadSkillsFromDir({ dir: join(directory, ".agents", "skills"), source: "workspace" }) : { skills: [], diagnostics: [] };
  const skills = new Map([...bundled.skills, ...local.skills].map(skill => [skill.name, skill]));
  return [formatSkillsForPrompt([...skills.values()]), ...[...bundled.diagnostics, ...local.diagnostics].map(item => `技能加载提示：${item.message}`)].join("\n\n");
}
function invalidExtension(): never { throw new AssistantError("EXTENSION_INVALID", "扩展清单或授权无效，扩展不能自行提升权限。"); }

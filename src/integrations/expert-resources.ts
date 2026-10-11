import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExtensionRuntime, loadSkillsFromDir, formatSkillsForPrompt, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import type { ExpertRef } from "../model/expert.js";

export async function roleText(role: "coordinator" | "researcher" | "reviewer", root: string) {
  let text = await readFile(join(resourceRoot, "roles", role + ".md"), "utf8");
  try { text += "\n\n工作区职责补充：\n" + await readFile(join(root, "roles", role + ".md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return text;
}
export async function expertLoader(root: string, role: ExpertRef["role"]): Promise<ResourceLoader> {
  const bundled = loadSkillsFromDir({ dir: join(resourceRoot, "skills"), source: "ffa" });
  const local = loadSkillsFromDir({ dir: join(root, ".agents", "skills"), source: "workspace" });
  const skills = [...local.skills, ...bundled.skills.filter(s =>
    role === "reviewer" && s.name === "trading" && !local.skills.some(l => l.name === s.name))];
  const context: { path: string; content: string }[] = [];
  for (const path of ["AGENTS.md", "sources/AGENTS.md"]) {
    try { context.push({ path: join(root, path), content: await readFile(join(root, path), "utf8") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const prompt = "FFA 包内资料根目录：" + resourceRoot + "\n" + await roleText(role, root);
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills, diagnostics: [...local.diagnostics, ...bundled.diagnostics] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: context }),
    getSystemPrompt: () => prompt + "\n" + context.map(c => c.content).join("\n") + "\n" + formatSkillsForPrompt(skills),
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}

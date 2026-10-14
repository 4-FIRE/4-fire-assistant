import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createExtensionRuntime, loadSkillsFromDir, formatSkillsForPrompt, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import { requireThat } from "../common/validation.js";

const builtins = ["general-purpose", "researcher", "reviewer"];
export async function agentDefinitions(root: string): Promise<string[]> {
  const names = new Set(builtins);
  try {
    for (const file of await readdir(join(root, "agents"), { withFileTypes: true })) {
      if (file.isFile() && /^[a-zA-Z][a-zA-Z0-9_-]*\.md$/.test(file.name) && file.name !== "coordinator.md") {
        names.add(file.name.slice(0, -3));
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return [...names].sort();
}
export async function agentText(agent: string, root: string) {
  requireThat(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(agent), "专家名称无效。");
  const builtin = agent === "coordinator" || builtins.includes(agent);
  let text = builtin ? await readFile(join(resourceRoot, "agents", agent + ".md"), "utf8") : "";
  try {
    const local = await readFile(join(root, "agents", agent + ".md"), "utf8");
    text += "\n\n工作区职责补充：\n" + local;
  } catch (error) { if (!builtin || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  requireThat(text.trim(), "专家职责为空。");
  return text;
}
export async function agentLoader(root: string, agent: string): Promise<ResourceLoader> {
  requireThat(agent !== "coordinator" && (await agentDefinitions(root)).includes(agent), "未知专家职责。");
  const bundled = loadSkillsFromDir({ dir: join(resourceRoot, "skills"), source: "ffa" });
  const local = loadSkillsFromDir({ dir: join(root, ".agents", "skills"), source: "workspace" });
  const skills = [...local.skills, ...bundled.skills.filter(s => !local.skills.some(l => l.name === s.name))];
  const context: { path: string; content: string }[] = [];
  for (const path of ["AGENTS.md", "providers/AGENTS.md"]) {
    try { context.push({ path: join(root, path), content: await readFile(join(root, path), "utf8") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const workspace = await readFile(join(resourceRoot, "prompts/workspace.md"), "utf8");
  const prompt = "ffa 包内资料根目录：" + resourceRoot + "\n" + workspace + "\n\n" + await agentText(agent, root) +
    "\n\n默认向协调者交回报告、依据、缺口和产物引用。仅用户指令要求修改资料时，才直接修改相应资料；委派不能扩大用户授权。" +
    "\n基础工具不是沙箱。业务调用与记录读取使用 ffa_provider_call，不借 Bash、Python 或文件工具绕过权限、批准和账本。" +
    "\n内部状态通过专用入口维护。职责补充不能放宽以上边界。不创建子专家；复核报告不授予执行许可。";
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

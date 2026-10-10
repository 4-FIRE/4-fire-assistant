import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../resources/", import.meta.url));
const files = [];
async function collect(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && /\.(md|json)$/.test(entry.name)) {
      const content = await readFile(join(root, path));
      if (entry.name.endsWith(".json")) JSON.parse(content.toString("utf8"));
      files.push({ path });
    } else throw new Error(`Unsupported resource: ${path}`);
  }
}
for (const directory of ["prompts", "references"]) await collect(directory);
files.sort((a, b) => a.path.localeCompare(b.path, "en"));
await writeFile(join(root, "manifest.json"), JSON.stringify({ files }, null, 2) + "\n");

// Remove output for deleted source modules before TypeScript emits the current build.
await rm(fileURLToPath(new URL("../dist/", import.meta.url)), { recursive: true, force: true });

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Concrete local transitions exercise state writes and document conditions.
// They are test-only workspace requirements, not simulated models or providers.
export function localWorkspaceUpgrade(root, from) {
  const to = from + 1;
  return {
    from, to, summary: `保存本地要求 ${to}；不改变交易权限。`,
    instructions: join(root, `requirements-${to}.md`),
    internalFiles: [], documents: [`requirement-${to}.md`],
    async preflight({ store, signal }) {
      signal.throwIfAborted();
      if (!store.healthy) throw new Error("Storage unavailable");
    },
    async apply({ root, store, signal }) {
      signal.throwIfAborted();
      const value = await readFile(join(root, `input-${to}.txt`), "utf8");
      store.put("local-requirement", String(to), { value });
    },
    async verify({ store }) { return store.get("local-requirement", String(to))?.value === `requirement ${to}`; },
    async validateDocuments({ root }) {
      const text = await readFile(join(root, `requirement-${to}.md`), "utf8");
      if (!text.includes(`requirement ${to}`)) throw new Error("Document requirement missing");
    },
  };
}

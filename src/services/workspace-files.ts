import { relative, isAbsolute } from "node:path";

export function mutationScope(root: string, target: string): "internal" | "outside" | "inside" {
  const rel = relative(root, target);
  if (rel === ".ffa" || rel.startsWith(".ffa/")) return "internal";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return "outside";
  return "inside";
}

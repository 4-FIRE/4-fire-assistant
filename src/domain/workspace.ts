import type { Parameters } from "./shared.js";
/** Initialization material is not an execution policy or a grant until confirmed and validated. */
export interface SetupMessage { role: "user" | "assistant"; text: string }
export interface SetupSource {
  name: string;
  kind: "mcp" | "cli";
  description: string;
  location: string;
  missing: string[];
  id?: string;
  connection?: Parameters;
  operations?: Parameters[];
  discoveryArgs?: string[];
}
export interface SetupDraft {
  sources: SetupSource[];
}
export interface WorkspaceConfig {
  version: 1;
  initialization: "pending" | "complete";
  messages: SetupMessage[];
  draft: SetupDraft;
  enabledSources?: string[];
  extensions?: Record<string, Record<string, string[]>>;
}
export function emptyWorkspace(): WorkspaceConfig {
  return { version: 1, initialization: "pending", messages: [],
    draft: { sources: [] } };
}

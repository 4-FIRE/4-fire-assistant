import type { Store } from "../storage/store.js";

export interface UpdateContext {
  root: string;
  store: Store;
  signal: AbortSignal;
}
/** Each installed transition owns its script and model-facing resource. */
export interface WorkspaceUpgrade {
  from: number;
  to: number;
  summary: string;
  instructions: string;
  internalFiles: string[];
  documents: string[];
  preflight(context: UpdateContext): Promise<void>;
  apply(context: UpdateContext): Promise<void>;
  verify(context: UpdateContext): Promise<boolean>;
  validateDocuments(context: UpdateContext): Promise<void>;
}

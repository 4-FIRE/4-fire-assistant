import type { Parameters, Evidence } from "./shared.js";
import { sameBinding } from "./shared.js";

export interface WorkspaceSource {
  connection: Parameters;
  operations: Parameters[];
}
export interface InitializationRecord {
  market: string;
  quoteRef: string;
  historyRef: string;
  completedAt: string;
}
export interface WorkspaceConfig {
  version: 2;
  initialization: InitializationRecord | null;
  sources: Record<string, WorkspaceSource>;
  extensions: Record<string, Record<string, string[]>>;
}
export function emptyWorkspace(): WorkspaceConfig {
  return { version: 2, initialization: null, sources: {}, extensions: {} };
}

/** Checks provenance, not service-specific quote or bar semantics. */
export function validInitializationEvidence(evidence: Evidence | undefined, current: Evidence["binding"]): boolean {
  return !!evidence?.success && !!evidence.binding && !!current && sameBinding(evidence.binding, current);
}

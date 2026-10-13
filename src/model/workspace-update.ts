export interface DocumentChange {
  path: string;
  change: string;
}
export interface UpdateStepPlan {
  from: number;
  documents: DocumentChange[];
}
export interface UpdateReport {
  modified: string[];
  unchanged: string[];
  unresolved: string[];
}
export interface UpdatePlan {
  documents: DocumentChange[];
  summary: string;
  instructions: string;
  internalFiles: string[];
  requiredDocuments: string[];
}
export interface UpdateBatch {
  id: string;
  from: number;
  to: number;
  stage: "planning" | "program" | "documents";
  plans: UpdatePlan[];
}
export interface WorkspaceUpdateState {
  version: number;
  batch?: UpdateBatch;
  approvals?: { from: number; plan: UpdatePlan }[];
}

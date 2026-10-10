import type { Evidence, Json, OperationSpec, Parameters, Role, Scope, ServiceBinding } from "../domain/shared.js";

export interface NativeOperation { name: string; description: string; schema: Parameters; schemaDigest: string }
export type ToolKind = "read" | "write";
export type ToolAccess = Record<string, ToolKind>;
export interface WriteRequirements { reviewRequired: boolean; confirmationRequired: true }
export interface NativeObservation { success: boolean; raw: Json; data: Json; outcome?: "accepted" | "rejected" | "unknown" }
/** A one-shot, application-owned closure; never accepted from model JSON. */
export interface DispatchPermit { consume(binding: ServiceBinding, operation: OperationSpec, scope: Scope): void }
export interface ToolPort {
  requirements?(name: string): WriteRequirements;
  allowed?(name: string, role: Role): boolean;
  status(): Json;
  catalog(): (NativeOperation & { kind?: ToolKind; execution?: WriteRequirements; invocation?: Parameters; resultSchema?: Parameters })[];
  kind(name: string): ToolKind | undefined;
  binding(name: string): ServiceBinding;
  refresh(signal?: AbortSignal): Promise<void>;
  validate(operation: OperationSpec): void;
  read(operation: OperationSpec, signal?: AbortSignal): Promise<NativeObservation>;
  dispatch(permit: DispatchPermit, operation: OperationSpec, scope: Scope, signal?: AbortSignal): Promise<NativeObservation>;
}
export interface Report {
  ref: string;
  ownerId: number;
  requestId: string;
  expertId: string | null;
  role: Role;
  createdAt: string;
  content: string;
  evidence: Evidence[];
  status: "answered" | "unanswered" | "cancelled";
}
export interface ExpertSummary { expertId: string; role: Role; purpose: string; busy: boolean; reportRefs: string[] }

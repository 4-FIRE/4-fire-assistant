import type { Operation, Provider } from "./provider.js";
import type { Permission, Permissions } from "./permission.js";

export type Connection =
  | { kind: "cli"; command: string; env?: Record<string, string> }
  | { kind: "mcp"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "mcp"; url: string; headers?: Record<string, string> };
export type CliDefinition = Omit<Operation, "native" | "outcomes">;
export type Coverage = NonNullable<Provider["coverage"]>;
export type Outcomes = NonNullable<Operation["outcomes"]>;
export type ManagementRead = { action: "read"; provider: string } & (
  | { target: "connection" | "coverage" | "permissions" }
  | { target: "operations"; operation?: string }
  | { target: "outcomes"; operation: string }
);
export type ManagementUpdate = { action: "update"; provider: string } & (
  | { target: "connection"; expectedRevision: string; config: Connection }
  | { target: "coverage"; expectedRevision: string; coverage: Coverage }
  | { target: "outcomes"; operation: string; expectedRevision: string; outcomes: Outcomes | null }
  | { target: "permissions"; expectedRevision: string; mode: "suggest" | "set"; permissions: Record<string, Permission | null> }
  | { target: "operations"; add?: (CliDefinition & { outcomes?: Outcomes })[];
      replace?: { expectedRevision: string; definition: CliDefinition }[];
      coverage?: { expectedRevision: string; value: Coverage } }
);
export type ManagementRequest = ManagementRead | ManagementUpdate
  | { action: "register"; provider: string; config: Connection; operations?: (CliDefinition & { outcomes?: Outcomes })[]; coverage?: Coverage; permissions?: Record<string, Permission> }
  | { action: "discover"; provider: string };
export interface PermissionResult {
  status: "not_started" | "complete" | "failed" | "unknown";
  applied: Record<string, Permission | null>;
  preserved: Record<string, Permission>;
}
export interface ManagementConfirmation {
  action: "register" | "update";
  target?: ManagementUpdate["target"];
  provider: Provider;
  clearedOutcomes: string[];
  permissions: { before: Permissions; after: Permissions; applied: Record<string, Permission | null>; preserved: Record<string, Permission> };
}
export interface ManagementFailure {
  category: "input" | "conflict" | "declined" | "storage" | "discovery" | "connection";
  path: string;
  message: string;
  next: string;
}
export interface ManagementResult {
  provider: string;
  action: "register" | "update" | "discover";
  configSaved?: boolean | null;
  permissions?: PermissionResult;
  discovery?: { status: "not_started" | "complete" | "failed"; limitations: string[] };
  saved?: unknown;
  error?: ManagementFailure;
}

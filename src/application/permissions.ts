import type { Role } from "../domain/shared.js";
import { AssistantError } from "./ports.js";

export type Capability = "read" | "delegate" | "prepare" | "review" | "execute" | "compute";
export type RolePermissions = Readonly<Record<string, readonly Capability[]>>;
export const builtInPermissions: RolePermissions = Object.freeze({
  coordinator: Object.freeze(["read", "delegate", "prepare", "execute", "compute"] as Capability[]),
  researcher: Object.freeze(["read", "compute"] as Capability[]),
  reviewer: Object.freeze(["read", "review", "compute"] as Capability[]),
});
export function can(role: Role, capability: Capability, roles: RolePermissions = builtInPermissions): boolean {
  return Object.hasOwn(roles, role) && roles[role]!.includes(capability);
}
export function requireCapability(role: Role, capability: Capability, roles: RolePermissions = builtInPermissions): void {
  if (!can(role, capability, roles)) throw new AssistantError("ROLE_DENIED", "当前角色没有这项应用能力。");
}

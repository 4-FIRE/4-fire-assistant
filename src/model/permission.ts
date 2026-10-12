export type Permission = "allow" | "ask" | "review" | "deny";
export interface Permissions {
  default: Permission;
  tools: Record<string, Permission>;
}

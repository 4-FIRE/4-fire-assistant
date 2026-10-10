/** Native service values, not a broker/portfolio model. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Parameters = { [key: string]: Json };
export type Role = string;
export interface Scope {
  conversationId: number;
  ownerId: number;
  requestId: string;
  role: Role;
  roundId: string;
}
export interface OperationSpec { name: string; parameters: Parameters }
export interface ServiceBinding {
  connectionId: string;
  epoch: string;
  accessDigest: string;
  schemaDigest: string;
}
export interface Evidence {
  ref: string;
  scope: Scope;
  operation: string;
  parameters: Parameters;
  obtainedAt: string;
  success: boolean;
  result: Json;
  raw?: Json;
  binding?: ServiceBinding;
}
export function canonical(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Only plain finite JSON is allowed");
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
export function sameBinding(a: ServiceBinding, b: ServiceBinding): boolean { return canonical({ ...a }) === canonical({ ...b }); }
export function sameOperation(a: OperationSpec, b: OperationSpec): boolean { return a.name === b.name && canonical(a.parameters) === canonical(b.parameters); }
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

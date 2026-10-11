import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Params = Record<string, Json>;
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  throw new Error("需要有限、可序列化的 JSON 值。");
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function json(value: unknown): Json { return JSON.parse(canonical(value)) as Json; }
export function schema(value: unknown): ValidateFunction {
  if (!object(value)) throw new Error("需要对象形式的 JSON Schema。");
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats.default(ajv);
  return ajv.compile(value);
}
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function result(value: unknown, isError = false, text?: string) {
  const data = json(value);
  return { content: [{ type: "text" as const, text: text ?? JSON.stringify(data) }],
    details: data, structuredContent: data, ...(isError ? { isError: true } : {}) };
}

import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { object } from "./json.js";

export function schema(value: unknown): ValidateFunction {
  if (!object(value)) throw new Error("需要对象形式的 JSON Schema。");
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats.default(ajv);
  return ajv.compile(value);
}
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

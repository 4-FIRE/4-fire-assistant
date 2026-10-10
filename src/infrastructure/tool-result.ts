import { AssistantError } from "../application/ports.js";
import { ExecutionViolation } from "../domain/execution.js";
import { json } from "./runtime-documents.js";

export function result(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: json(value), isError }; }
export function toolError(error: unknown, fallback: string) { return result({ error: error instanceof AssistantError || error instanceof ExecutionViolation ? error.code : "BUSINESS_TOOL_FAILED",
  message: error instanceof AssistantError || error instanceof ExecutionViolation ? error.message : fallback }, true); }

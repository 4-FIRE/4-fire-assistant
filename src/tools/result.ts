import { json } from "../common/json.js";

export function result(value: unknown, isError = false, text?: string) {
  const data = json(value);
  return { content: [{ type: "text" as const, text: text ?? JSON.stringify(data) }],
    details: data, structuredContent: data, ...(isError ? { isError: true } : {}) };
}

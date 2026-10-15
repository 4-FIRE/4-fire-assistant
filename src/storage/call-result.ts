import { canonical, object, type Json } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";
import type { Observation } from "../model/receipt.js";

export interface CallResult { data: Json; raw?: Json }
const valid = schema({ type: "object", additionalProperties: false, required: ["data"], properties: { data: {}, raw: {} } });
export function parseCallResult(value: unknown): CallResult {
  requireThat(valid(value), "调用结果正文无效。"); canonical(value);
  return value as CallResult;
}

/** Keep distinct diagnostics, not a second encoding of the result in stdout. */
export function callResult(observation: Observation): CallResult {
  let raw = observation.raw;
  if (object(raw)) {
    raw = { ...raw };
    if (typeof raw.stdout === "string") {
      // Ignore only JSON whitespace outside strings. Parsing again would lose large integer digits.
      const compact = raw.stdout.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, part => part.startsWith("\"") ? part : "");
      if (compact === JSON.stringify(observation.data)) delete raw.stdout;
    }
    if (object(observation.data)) {
      for (const key of Object.keys(raw)) {
        if (Object.hasOwn(observation.data, key) && canonical(raw[key]) === canonical(observation.data[key])) delete raw[key];
      }
    }
  }
  return { data: observation.data, ...(raw === undefined ? {} : { raw }) };
}

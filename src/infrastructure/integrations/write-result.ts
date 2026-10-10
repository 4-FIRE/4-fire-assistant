import type { ValidateFunction } from "ajv";
import type { NativeObservation } from "../../application/business-ports.js";
import type { Parameters } from "../../domain/shared.js";

/** Both schemas describe the complete native result, including every batch item. */
export interface WriteResultContract { accepted: Parameters; rejected: Parameters }
export function classifyWrite(result: NativeObservation, accepted: ValidateFunction, rejected: ValidateFunction): NativeObservation {
  const yes = !!accepted(result.data), no = !!rejected(result.data);
  const outcome = yes === no ? "unknown" : yes ? "accepted" : "rejected";
  return { ...result, outcome, success: outcome === "accepted" };
}

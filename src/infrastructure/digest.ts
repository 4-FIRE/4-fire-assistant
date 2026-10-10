import { createHash } from "node:crypto";
import { canonical, type Json } from "../domain/shared.js";

/** Digests JSON values for operation and connection identity. */
export function digest(value: Json): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

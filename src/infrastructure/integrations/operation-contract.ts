import { AssistantError } from "../../application/ports.js";
import type { WriteRequirements } from "../../application/business-ports.js";
import { canonical, object, type Parameters } from "../../domain/shared.js";
import { compileToolSchema } from "./tool-schema.js";
import type { WriteResultContract } from "./write-result.js";

export interface OperationContract {
  name: string;
  description: string;
  access: "read" | "write";
  execution?: WriteRequirements;
  outcomes?: WriteResultContract;
  schema?: Parameters;
  resultSchema?: Parameters;
}
function invalid(): never { throw new AssistantError("INVALID_TOOL_CONTRACT", "操作约定无效；需要操作身份、读写分类和可校验 schema。"); }
function schema(value: unknown): Parameters {
  if (!object(value)) invalid();
  canonical(value as Parameters); compileToolSchema(value as Parameters);
  return value as Parameters;
}
/** Shared operation rules do not require a CLI command or argument binding. */
export function parseOperationContract(value: unknown): OperationContract {
  if (!object(value) || typeof value.name !== "string" || !value.name.trim() || value.name !== value.name.trim() ||
      value.description !== undefined && typeof value.description !== "string" ||
      value.access !== "read" && value.access !== "write" ||
      Object.keys(value).some(key => !["name", "description", "access", "schema", "resultSchema", "execution", "outcomes"].includes(key))) invalid();
  const inputSchema = value.schema === undefined ? undefined : schema(value.schema);
  if (inputSchema && inputSchema.type !== "object") invalid();
  const resultSchema = value.resultSchema === undefined ? undefined : schema(value.resultSchema);
  let execution: WriteRequirements | undefined, outcomes: WriteResultContract | undefined;
  if (value.access === "write") {
    if (value.execution !== undefined && (!object(value.execution) || value.execution.reviewRequired !== true || value.execution.confirmationRequired !== true ||
        Object.keys(value.execution).some(key => !["reviewRequired", "confirmationRequired"].includes(key)))) invalid();
    if (value.outcomes !== undefined && (!object(value.outcomes) || Object.keys(value.outcomes).some(key => !["accepted", "rejected"].includes(key)))) invalid();
    execution = { reviewRequired: true, confirmationRequired: true };
    outcomes = value.outcomes === undefined ? { accepted: { not: {} }, rejected: { not: {} } } :
      { accepted: schema((value.outcomes as Parameters).accepted), rejected: schema((value.outcomes as Parameters).rejected) };
  } else if (value.execution !== undefined || value.outcomes !== undefined) invalid();
  return structuredClone({ name: value.name, description: value.description ?? "", access: value.access,
    ...(inputSchema ? { schema: inputSchema } : {}), ...(resultSchema ? { resultSchema } : {}),
    ...(execution && outcomes ? { execution, outcomes } : {}) });
}

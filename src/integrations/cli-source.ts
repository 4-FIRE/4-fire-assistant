import { canonical, type Params } from "../common/json.js";
import type { Source, Operation } from "../model/source.js";
import { environment } from "./source-environment.js";
import { runCommand } from "./process.js";

export function invokeCli(root: string, source: Source, operation: Operation, parameters: Params, preview: Params,
  gate: (native: unknown) => void, signal?: AbortSignal) {
  gate(operation.inputSchema);
  return runCommand(source.command!, preview.argv as string[], operation.stdin ? canonical(parameters) : undefined,
    root, environment(source), signal);
}

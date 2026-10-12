import { canonical, type Params } from "../common/json.js";
import type { Provider, Operation } from "../model/provider.js";
import { environment } from "./provider-environment.js";
import { runCommand } from "./process.js";

export function invokeCli(root: string, provider: Provider, operation: Operation, parameters: Params, preview: Params,
  gate: (native: unknown) => void, signal?: AbortSignal) {
  gate(operation.inputSchema);
  return runCommand(provider.command!, preview.argv as string[], operation.stdin ? canonical(parameters) : undefined,
    root, environment(provider), signal);
}

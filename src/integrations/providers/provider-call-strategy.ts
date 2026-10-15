import type { Params } from "../../common/json.js";
import type { Operation, Provider } from "../../model/provider.js";
import type { Observation } from "../../model/receipt.js";

export interface ProviderCallStrategy {
  prepare(provider: Provider): Promise<void>;
  environment(provider: Provider): Record<string, string>;
  preview(provider: Provider, operation: Operation, parameters: Params): Params;
  definition(provider: Provider, operation: Operation, signal?: AbortSignal): Promise<Params>;
  invoke(provider: Provider, operation: Operation, parameters: Params,
    gate: (native: Params) => void, signal?: AbortSignal): Promise<Observation>;
}

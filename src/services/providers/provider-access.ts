import type { Params } from "../../common/json.js";
import type { Provider, Operation } from "../../model/provider.js";
import type { Observation } from "../../model/receipt.js";

export interface ProviderAccess {
  replace(provider: Provider): Promise<void>;
  discover(provider: Provider, signal?: AbortSignal, refresh?: boolean): Promise<Params[]>;
  preview(provider: Provider, operation: Operation, parameters: Params): Params;
  binding(provider: Provider, operation: Operation, signal?: AbortSignal): Promise<string>;
  identity(provider: Provider, native: Params): string;
  invoke(provider: Provider, operation: Operation, parameters: Params,
    gate: (native: Params) => void, signal?: AbortSignal): Promise<Observation>;
  close(): Promise<void>;
}

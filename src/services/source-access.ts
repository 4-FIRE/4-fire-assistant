import type { Params } from "../common/json.js";
import type { Source, Operation } from "../model/source.js";
import type { Observation } from "../model/receipt.js";

export interface SourceAccess {
  replace(source: Source): Promise<void>;
  discover(source: Source, signal?: AbortSignal): Promise<Params[]>;
  binding(source: Source, operation: Operation, signal?: AbortSignal): Promise<string>;
  identity(source: Source, native: unknown): string;
  invoke(source: Source, operation: Operation, parameters: Params, preview: Params,
    gate: (native: unknown) => void, signal?: AbortSignal, write?: boolean): Promise<Observation>;
  close(): Promise<void>;
}

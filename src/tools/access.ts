import type { Scope } from "../model/execution-intent.js";

/** Each tool is bound to one workspace instance, not a mutable global lookup. */
export interface CallAccess {
  check(ready?: boolean): void;
  signal(signal?: AbortSignal): AbortSignal;
  scope(session: string): Scope;
}

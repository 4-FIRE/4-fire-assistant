import type { Params } from "../common/json.js";

export class Operation {
  declare name: string;
  declare description: string;
  declare inputSchema: Params;
  declare available?: boolean;
  declare native?: Params;
  declare argv?: (string | { parameter: string } | { json: true })[];
  declare stdin?: boolean;
  declare outcomes?: { accepted: Params; rejected: Params };
  constructor(value: Operation) { Object.assign(this, value); }
}
export class Provider {
  declare id: string;
  declare kind: "cli" | "mcp";
  declare command?: string;
  declare args?: string[];
  declare env?: Record<string, string>;
  declare url?: string;
  declare headers?: Record<string, string>;
  declare coverage?: { basis: string; limitations: string[] };
  declare discovery?: { status: "complete" | "stale" | "failed"; at: string; scope: string };
  declare operations: Operation[];
  constructor(value: Provider) {
    Object.assign(this, value);
    this.operations = value.operations.map(operation => new Operation(operation));
  }
}

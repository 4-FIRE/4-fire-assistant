import type { Params } from "../common/json.js";
import type { Observation } from "./receipt.js";

export class Intent {
  declare id: string;
  declare session: string;
  declare request: string;
  declare objective: string;
  declare source: string;
  declare operation: string;
  declare parameters: Params;
  declare binding: string;
  declare createdAt: string;
  declare execution: "confirmation" | "independent";
  declare state: "prepared" | "dispatched" | "observed" | "unknown" | "closed" | "declined";
  declare attempt?: { id: string; at: string };
  declare observation?: Observation;
  declare outcome?: "accepted" | "rejected" | "unknown";
  declare review?: { expert: string; approved: boolean; evidence: string[]; note: string };
  declare resolution?: string;
  constructor(value: Intent) { Object.assign(this, value); }
}
export class Scope {
  constructor(public session: string, public request: string) {}
}

import type { Params } from "../common/json.js";
import type { Observation } from "./receipt.js";
import type { Permission } from "./permission.js";

export class Intent {
  declare id: string;
  declare session: string;
  declare provider: string;
  declare operation: string;
  declare parameters: Params;
  declare binding: string;
  declare createdAt: string;
  declare permission: Exclude<Permission, "deny">;
  declare receiptId?: string;
  declare state: "pending" | "dispatched" | "observed" | "unknown" | "declined";
  declare attempt?: { id: string; at: string };
  declare observation?: Pick<Observation, "success">;
  declare outcome?: "accepted" | "rejected" | "unknown";
  constructor(value: Intent) { Object.assign(this, value); }
}
export class Scope {
  constructor(public session: string) {}
}

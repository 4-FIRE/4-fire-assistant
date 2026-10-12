import type { Json, Params } from "../common/json.js";

export class Receipt {
  declare id: string;
  declare provider: string;
  declare operation: string;
  declare parameters: Params;
  declare binding: string;
  declare at: string;
  declare success: boolean;
  declare data: Json;
  constructor(value: Receipt) { Object.assign(this, value); }
}
export class Observation {
  declare success: boolean;
  declare data: Json;
  declare raw?: Json;
  constructor(value: Observation) { Object.assign(this, value); }
}

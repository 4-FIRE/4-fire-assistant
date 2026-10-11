import { Type } from "typebox";

const string = Type.String();
const strings = Type.Array(string);
const params = Type.Record(Type.String(), Type.Unknown());
const observation = Type.Object({ success: Type.Boolean(), data: Type.Unknown(), raw: Type.Optional(Type.Unknown()) });
const review = Type.Object({ expert: string, approved: Type.Boolean(), evidence: strings, note: string });
export const intentOutput = Type.Object({
  id: string, session: string, request: string, objective: string, source: string, operation: string,
  parameters: params, binding: string, createdAt: string,
  execution: Type.Union([Type.Literal("confirmation"), Type.Literal("independent")]),
  state: Type.Union(["prepared", "dispatched", "observed", "unknown", "closed", "declined"].map(value => Type.Literal(value))),
  attempt: Type.Optional(Type.Object({ id: string, at: string })), observation: Type.Optional(observation),
  outcome: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unknown")])),
  review: Type.Optional(review), resolution: Type.Optional(string),
});

import { Type } from "typebox";

const string = Type.String();
const params = Type.Record(Type.String(), Type.Unknown());
const observation = Type.Object({ success: Type.Boolean() });
export const intentOutput = Type.Object({
  id: string, session: string, provider: string, operation: string,
  parameters: params, binding: string, createdAt: string,
  permission: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("review")]),
  receiptId: Type.Optional(string),
  state: Type.Union(["pending", "dispatched", "observed", "unknown", "declined"].map(value => Type.Literal(value))),
  attempt: Type.Optional(Type.Object({ id: string, at: string })), observation: Type.Optional(observation),
  outcome: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unknown")])),
});

import { Type } from "typebox";

const string = Type.String();
const strings = Type.Array(string);
const params = Type.Record(Type.String(), Type.Unknown());
const observation = Type.Object({ success: Type.Boolean(), data: Type.Unknown(), raw: Type.Optional(Type.Unknown()) });
const review = Type.Object({ expert: string, approved: Type.Boolean(), evidence: strings, note: string });
const operation = Type.Object({
  name: string, description: string, access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  signature: string, inputSchema: params,
  argv: Type.Optional(Type.Array(Type.Unknown())), stdin: Type.Optional(Type.Boolean()),
  outcomes: Type.Optional(Type.Object({ accepted: params, rejected: params })),
});
const intentOutput = Type.Object({
  id: string, session: string, request: string, objective: string, source: string, operation: string,
  parameters: params, binding: string, createdAt: string,
  state: Type.Union(["prepared", "dispatched", "observed", "unknown", "closed", "declined"].map(value => Type.Literal(value))),
  attempt: Type.Optional(Type.Object({ id: string, at: string })), observation: Type.Optional(observation),
  outcome: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unknown")])),
  review: Type.Optional(review), resolution: Type.Optional(string),
});
export const outputs = {
  receipt: Type.Object({ id: string, source: string, operation: string, parameters: params, binding: string,
    at: string, success: Type.Boolean(), data: Type.Unknown() }),
  python: Type.Object({ id: string, path: string,
    state: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]), output: Type.Unknown() }),
  sources: Type.Object({ sources: Type.Array(Type.Object({ id: string,
    kind: Type.Union([Type.Literal("cli"), Type.Literal("mcp")]), operations: Type.Array(operation) })), notices: strings }),
  record: Type.Object({ text: string, nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }),
  configured: Type.Object({ configured: string, next: string }),
  initialized: Type.Object({ ready: Type.Literal(true), next: string }),
  status: Type.Object({ workspace: Type.Object({ format: Type.Literal("ffa-pi/1"), status: Type.Literal("ready"), market: string }),
    unresolved: Type.Array(intentOutput), notices: strings }),
  intent: intentOutput,
  expert: Type.Object({ expert: Type.Object({ id: string, role: Type.Union([Type.Literal("researcher"), Type.Literal("reviewer")]), file: string }),
    report: string, failed: Type.Boolean() }),
  review: Type.Object({ approved: Type.Boolean() }),
};

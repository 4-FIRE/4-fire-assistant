import { Type } from "typebox";
import { params } from "./input.js";

const strings = Type.Array(Type.String());
export const operationOutput = Type.Object({
  name: Type.String(), description: Type.String(), inputSchema: params,
  effect: Type.Union([Type.Literal("observe"), Type.Literal("change"), Type.Literal("unresolved")]),
  assessment: Type.Union([Type.Literal("unassessed"), Type.Literal("uncertain"), Type.Literal("understood")]),
  analysis: Type.Optional(Type.Object({ purpose: Type.String(), basis: Type.String(), consequences: Type.String(),
    related: strings, impacts: strings, execution: Type.Union([Type.Literal("confirmation"), Type.Literal("independent")]) })),
  blocked: Type.Optional(Type.String()), available: Type.Optional(Type.Boolean()), native: Type.Optional(params),
  signature: Type.Optional(Type.String()), argv: Type.Optional(Type.Array(Type.Unknown())), stdin: Type.Optional(Type.Boolean()),
  outcomes: Type.Optional(Type.Object({ accepted: params, rejected: params })),
});
export const catalogOutput = Type.Object({ id: Type.String(), kind: Type.Union([Type.Literal("cli"), Type.Literal("mcp")]),
  discovery: Type.Optional(Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("stale"), Type.Literal("failed")]), at: Type.String(), scope: Type.String() })),
  coverage: Type.Optional(Type.Object({ basis: Type.String(), limitations: strings })),
  operations: Type.Array(operationOutput),
});

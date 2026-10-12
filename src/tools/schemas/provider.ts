import { Type } from "typebox";
import { params } from "./input.js";

export const permissionSchema = Type.Union(["allow", "ask", "review", "deny"].map(value => Type.Literal(value)));
export const operationOutput = Type.Object({
  name: Type.String(), description: Type.String(), inputSchema: params,
  id: Type.String(), permission: permissionSchema,
  available: Type.Optional(Type.Boolean()), native: Type.Optional(params),
  signature: Type.Optional(Type.String()), argv: Type.Optional(Type.Array(Type.Unknown())), stdin: Type.Optional(Type.Boolean()),
  outcomes: Type.Optional(Type.Object({ accepted: params, rejected: params })),
});
export const catalogOutput = Type.Object({ id: Type.String(), kind: Type.Union([Type.Literal("cli"), Type.Literal("mcp")]),
  discovery: Type.Optional(Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("stale"), Type.Literal("failed")]), at: Type.String(), scope: Type.String() })),
  coverage: Type.Optional(Type.Object({ basis: Type.String(), limitations: Type.Array(Type.String()) })),
  operations: Type.Array(operationOutput),
});

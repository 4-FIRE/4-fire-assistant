import { Type } from "typebox";
import { permissionSchema, argvSchema } from "./provider.js";
import { params } from "./input.js";

const strict = { additionalProperties: false };
export const providerId = Type.String({ pattern: "^[a-z][a-z0-9_]{0,47}$" });
const name = Type.String({ minLength: 1 });
const revision = Type.String({ minLength: 1 });
const env = Type.Record(Type.String(), Type.String({ pattern: "^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$" }));
const headers = Type.Record(Type.String(), Type.String({ pattern: "^(Bearer )?\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$" }));
export const connectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("cli"), command: Type.String({ pattern: "^[A-Za-z0-9_][A-Za-z0-9_.+-]*$" }), env: Type.Optional(env) }, strict),
  Type.Object({ kind: Type.Literal("mcp"), command: Type.String({ pattern: "^/" }), args: Type.Optional(Type.Array(Type.String())), env: Type.Optional(env) }, strict),
  Type.Object({ kind: Type.Literal("mcp"), url: Type.String({ minLength: 1 }), headers: Type.Optional(headers) }, strict),
]);
export const coverageSchema = Type.Object({ basis: Type.String({ minLength: 1 }), limitations: Type.Array(Type.String()) }, strict);
export const outcomesSchema = Type.Object({ accepted: params, rejected: params }, strict);
const argv = argvSchema;
const operationFields = { name, description: Type.String(), inputSchema: Type.Intersect([params, Type.Object({ type: Type.Literal("object") })]),
  stdin: Type.Optional(Type.Boolean()) };
export const cliDefinition = Type.Union([
  Type.Object({ ...operationFields, available: Type.Optional(Type.Literal(true)), argv }, strict),
  Type.Object({ ...operationFields, available: Type.Literal(false), argv: Type.Optional(argv) }, strict),
]);
export const cliNewDefinition = Type.Union(cliDefinition.anyOf.map(branch => Type.Object({ ...branch.properties, outcomes: Type.Optional(outcomesSchema) }, strict)));
const read = { action: Type.Literal("read"), provider: providerId };
const update = { action: Type.Literal("update"), provider: providerId };
const permissions = Type.Record(name, permissionSchema);
const register = { action: Type.Literal("register"), provider: providerId };
export const managementBranches = [
  ...["connection", "coverage", "permissions"].map(target => Type.Object({ ...read, target: Type.Literal(target) }, strict)),
  Type.Object({ ...read, target: Type.Literal("operations"), operation: Type.Optional(name) }, strict),
  Type.Object({ ...read, target: Type.Literal("outcomes"), operation: name }, strict),
  Type.Object({ ...register, config: connectionSchema.anyOf[0], coverage: coverageSchema, operations: Type.Array(cliNewDefinition), permissions: Type.Optional(permissions) }, strict),
  ...connectionSchema.anyOf.slice(1).map(config => Type.Object({ ...register, config }, strict)),
  Type.Object({ action: Type.Literal("discover"), provider: providerId }, strict),
  Type.Object({ ...update, target: Type.Literal("connection"), expectedRevision: revision, config: connectionSchema }, strict),
  Type.Object({ ...update, target: Type.Literal("coverage"), expectedRevision: revision, coverage: coverageSchema }, strict),
  Type.Object({ ...update, target: Type.Literal("outcomes"), operation: name, expectedRevision: revision, outcomes: Type.Union([outcomesSchema, Type.Null()]) }, strict),
  Type.Object({ ...update, target: Type.Literal("permissions"), mode: Type.Literal("suggest"), expectedRevision: revision, permissions }, strict),
  Type.Object({ ...update, target: Type.Literal("permissions"), mode: Type.Literal("set"), expectedRevision: revision,
    permissions: Type.Record(name, Type.Union([permissionSchema, Type.Null()])) }, strict),
  Type.Object({ ...update, target: Type.Literal("operations"), add: Type.Optional(Type.Array(cliNewDefinition)),
    replace: Type.Optional(Type.Array(Type.Object({ expectedRevision: revision, definition: cliDefinition }, strict))),
    coverage: Type.Optional(Type.Object({ expectedRevision: revision, value: coverageSchema }, strict)) }, strict),
];
export const managementInput = Type.Union(managementBranches);
const revised = { revision };
const readResult = { provider: providerId, action: Type.Literal("read") };
const permissionValues = Type.Record(name, permissionSchema);
export const managementReadOutput = Type.Union([
  Type.Object({ ...readResult, target: Type.Literal("connection"), ...revised, config: connectionSchema, state: params }, strict),
  Type.Object({ ...readResult, target: Type.Literal("coverage"), ...revised, coverage: coverageSchema }, strict),
  Type.Object({ ...readResult, target: Type.Literal("outcomes"), operation: name, ...revised, outcomes: Type.Union([outcomesSchema, Type.Null()]) }, strict),
  Type.Object({ ...readResult, target: Type.Literal("operations"), operations: Type.Array(Type.Object({ ...revised, definition: cliDefinition }, strict)),
    coverage: Type.Object({ ...revised, value: coverageSchema }, strict) }, strict),
  Type.Object({ ...readResult, target: Type.Literal("permissions"), ...revised, default: permissionSchema, explicit: permissionValues, effective: permissionValues }, strict),
]);
export const managementOutput = Type.Union([managementReadOutput,
  Type.Object({ provider: providerId, action: Type.Union([Type.Literal("register"), Type.Literal("update"), Type.Literal("discover")]),
    configSaved: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    permissions: Type.Optional(Type.Object({ status: Type.Union(["not_started", "complete", "failed", "unknown"].map(v => Type.Literal(v))),
      applied: Type.Record(name, Type.Union([permissionSchema, Type.Null()])), preserved: permissionValues }, strict)),
    discovery: Type.Optional(Type.Object({ status: Type.Union(["not_started", "complete", "failed"].map(v => Type.Literal(v))), limitations: Type.Array(Type.String()) }, strict)),
    saved: Type.Optional(managementReadOutput),
    error: Type.Optional(Type.Object({ category: Type.Union(["input", "conflict", "declined", "storage", "discovery", "connection"].map(v => Type.Literal(v))),
      path: Type.String(), message: Type.String(), next: Type.String() }, strict)) }, strict),
]);

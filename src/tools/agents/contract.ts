import { Type } from "typebox";
import { name } from "../input.js";

const message = Type.String({ minLength: 1, maxLength: 24000 });
const mode = Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")]));
const page = { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) };
// Keep the model-facing schema an object; not all model APIs accept a root union.
export const agentParametersSchema = Type.Object({
  action: Type.Union(["start", "continue", "steer", "list", "read", "wait", "stop"].map(value => Type.Literal(value))),
  agent: Type.Optional(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$", maxLength: 128, description: "仅 start 必填，职责定义名。" })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "continue/steer/read/wait/stop 必填，执行 ID。" })),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 24000, description: "start/continue/steer 必填，任务或补充信息。" })),
  mode, ...page,
}, { additionalProperties: false });
// Execution also validates action-specific required and forbidden fields.
export const agentActionSchema = Type.Union([
  Type.Object({ action: Type.Literal("start"), agent: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$", maxLength: 128 }), message, mode }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("continue"), runId: name, message, mode }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("steer"), runId: name, message }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read"), runId: name, ...page }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("wait"), runId: name, ...page }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("stop"), runId: name }, { additionalProperties: false }),
]);
export const agentUsageSchema = Type.Object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number(),
  reasoning: Type.Optional(Type.Number()), cacheWrite1h: Type.Optional(Type.Number()),
  cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number() }),
});
export const agentExecutionSchema = Type.Object({
  runId: Type.String(), agent: Type.String(), message: Type.String(), mode: Type.Union([Type.Literal("foreground"), Type.Literal("background")]),
  state: Type.Union(["queued", "running", "completed", "failed", "cancelled", "interrupted"].map(value => Type.Literal(value))),
  createdAt: Type.Number(), startedAt: Type.Optional(Type.Number()), finishedAt: Type.Optional(Type.Number()),
  checkpoint: Type.Optional(Type.Object({ file: Type.String(), leaf: Type.Union([Type.String(), Type.Null()]) })),
  activity: Type.String(), report: Type.String(), error: Type.Optional(Type.String()), usage: agentUsageSchema,
  messageStatus: Type.Optional(Type.Union([Type.Literal("queued"), Type.Literal("handled")])),
  totalLength: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]),
}, { additionalProperties: false });
export const agentResultSchema = Type.Union([
  Type.Object({ agents: Type.Array(Type.String()), runs: Type.Array(agentExecutionSchema) }, { additionalProperties: false }), agentExecutionSchema,
]);

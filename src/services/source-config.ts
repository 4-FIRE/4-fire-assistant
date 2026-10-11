import { isAbsolute } from "node:path";
import { Source } from "../model/source.js";
import { object, type Params } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";

const sourceSchema = schema({ type: "object", additionalProperties: false,
  required: ["id", "kind", "operations"], properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,47}$" }, kind: { enum: ["cli", "mcp"] },
    command: { type: "string", minLength: 1 }, args: { type: "array", items: { type: "string" } }, url: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string", pattern: "^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$" } },
    headers: { type: "object", additionalProperties: { type: "string", pattern: "^(Bearer )?\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$" } },
    coverage: { type: "object", additionalProperties: false, required: ["basis", "limitations"], properties: {
      basis: { type: "string", minLength: 1 }, limitations: { type: "array", items: { type: "string" } } } },
    discovery: { type: "object", additionalProperties: false, required: ["status", "at", "scope"], properties: {
      status: { enum: ["complete", "stale", "failed"] }, at: { type: "string" }, scope: { type: "string" } } },
    operations: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["name", "description", "effect", "assessment", "inputSchema"], properties: {
        name: { type: "string", minLength: 1 }, description: { type: "string" },
        effect: { enum: ["observe", "change", "unresolved"] }, assessment: { enum: ["unassessed", "uncertain", "understood"] },
        blocked: { type: "string", minLength: 1 }, available: { type: "boolean" }, native: { type: "object" },
        analysis: { type: "object", additionalProperties: false, required: ["purpose", "basis", "consequences", "related", "impacts", "execution"], properties: {
          purpose: { type: "string", minLength: 1 }, basis: { type: "string", minLength: 1 }, consequences: { type: "string", minLength: 1 },
          related: { type: "array", items: { type: "string" } }, impacts: { type: "array", items: { type: "string", minLength: 1 } },
          execution: { enum: ["confirmation", "independent"] } } },
        inputSchema: { type: "object" }, stdin: { type: "boolean" },
        argv: { type: "array", items: { anyOf: [ { type: "string" },
          { type: "object", required: ["parameter"], additionalProperties: false, properties: { parameter: { type: "string" } } },
          { type: "object", required: ["json"], additionalProperties: false, properties: { json: { const: true } } } ] } },
        outcomes: { type: "object", required: ["accepted", "rejected"], additionalProperties: false,
          properties: { accepted: { type: "object" }, rejected: { type: "object" } } }
      } } }
  } });
export function parseSource(value: unknown): Source {
  requireThat(sourceSchema(value), "来源配置无效。凭据只能引用 ${ENV_NAME}。");
  const source = structuredClone(value) as Source;
  requireThat(Boolean(source.command) !== Boolean(source.url), "来源必须指定 command 或 url，不能同时指定。");
  if (source.command) requireThat(isAbsolute(source.command) && !source.command.includes("\0"), "command 必须是绝对路径。");
  if (source.url) {
    const url = new URL(source.url);
    requireThat(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "URL 不得含凭据、查询或片段。");
  }
  requireThat(!source.url || !source.env && !source.args, "HTTP 来源不接受 env 或 args。");
  requireThat(!source.command || !source.headers, "本地来源不接受 headers。");
  if (source.kind === "cli") {
    requireThat(source.command && !source.args && !source.url, "CLI 需要 command；不接受来源级 args。");
    requireThat(source.coverage?.basis.trim(), "CLI 目录需要资料依据和覆盖缺口。");
  }
  const names = new Set<string>();
  for (const op of source.operations) {
    requireThat(!names.has(op.name), "操作名重复。"); names.add(op.name);
    requireThat(op.inputSchema.type === "object", "输入 schema 必须约束对象。");
    if (op.effect !== "unresolved") schema(op.inputSchema);
    requireThat((op.effect === "unresolved") === (op.assessment !== "understood"), "影响与分析状态不一致。");
    if (op.assessment !== "unassessed") requireThat(op.analysis?.purpose.trim() && op.analysis.basis.trim() && op.analysis.consequences.trim(), "需要用途、判断依据和后果说明。");
    if (op.effect === "change") {
      requireThat(op.outcomes, "变更必须声明 accepted/rejected 回执 schema。");
      if (op.analysis!.impacts.length) {
        requireThat(op.analysis!.execution === "independent", "声明了敏感或额外影响的变更需要独立复核。");
      }
    }
    if (op.outcomes) { schema(op.outcomes.accepted); schema(op.outcomes.rejected); }
    if (source.kind === "cli") {
      requireThat(op.effect === "unresolved" || op.argv, "可调用 CLI 操作需要 argv。");
      if (!op.argv) continue;
      const whole = op.stdin || op.argv.some(token => object(token) && "json" in token);
      const properties = object(op.inputSchema.properties) ? op.inputSchema.properties : {};
      const bound = new Set(op.argv.flatMap(token => object(token) && "parameter" in token ? [token.parameter] : []));
      requireThat(whole || op.inputSchema.additionalProperties === false && Object.keys(properties).every(key => bound.has(key)), "CLI 参数必须全部绑定 argv 或 JSON 输入。");
    } else requireThat(op.argv === undefined && op.stdin === undefined, "MCP 不使用 argv 或 stdin 绑定。");
  }
  return new Source(source);
}

/** Keep class prototypes out of persisted data and connection identity. */
export function sourceData(source: Source): Params {
  return structuredClone({ ...source, operations: source.operations.map(operation => ({ ...operation })) }) as unknown as Params;
}

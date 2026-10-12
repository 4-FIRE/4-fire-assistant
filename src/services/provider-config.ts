import { isAbsolute } from "node:path";
import { Provider } from "../model/provider.js";
import { object, type Params } from "../common/json.js";
import { requireThat, schema } from "../common/validation.js";

const providerSchema = schema({ type: "object", additionalProperties: false,
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
      required: ["name", "description", "inputSchema"], properties: {
        name: { type: "string", minLength: 1 }, description: { type: "string" },
        available: { type: "boolean" }, native: { type: "object" },
        inputSchema: { type: "object" }, stdin: { type: "boolean" },
        argv: { type: "array", items: { anyOf: [ { type: "string" },
          { type: "object", required: ["parameter"], additionalProperties: false, properties: { parameter: { type: "string" } } },
          { type: "object", required: ["json"], additionalProperties: false, properties: { json: { const: true } } } ] } },
        outcomes: { type: "object", required: ["accepted", "rejected"], additionalProperties: false,
          properties: { accepted: { type: "object" }, rejected: { type: "object" } } }
      } } }
  } });
export function parseProvider(value: unknown): Provider {
  requireThat(providerSchema(value), "能力提供方配置无效。凭据只能引用 ${ENV_NAME}。");
  const provider = structuredClone(value) as Provider;
  requireThat(Boolean(provider.command) !== Boolean(provider.url), "能力提供方必须指定 command 或 url，不能同时指定。");
  if (provider.command) requireThat(isAbsolute(provider.command) && !provider.command.includes("\0"), "command 必须是绝对路径。");
  if (provider.url) {
    const url = new URL(provider.url);
    requireThat(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "URL 不得含凭据、查询或片段。");
  }
  requireThat(!provider.url || !provider.env && !provider.args, "HTTP 能力提供方不接受 env 或 args。");
  requireThat(!provider.command || !provider.headers, "本地能力提供方不接受 headers。");
  if (provider.kind === "cli") {
    requireThat(provider.command && !provider.args && !provider.url, "CLI 需要 command；不接受能力提供方级 args。");
    requireThat(provider.coverage?.basis.trim(), "CLI 目录需要资料依据和覆盖缺口。");
  }
  const names = new Set<string>();
  for (const op of provider.operations) {
    requireThat(!names.has(op.name), "操作名重复。"); names.add(op.name);
    requireThat(op.inputSchema.type === "object", "输入 schema 必须约束对象。");
    schema(op.inputSchema);
    if (op.outcomes) { schema(op.outcomes.accepted); schema(op.outcomes.rejected); }
    if (provider.kind === "cli") {
      requireThat(op.available === false || op.argv, "可调用 CLI 操作需要 argv。");
      if (!op.argv) continue;
      const whole = op.stdin || op.argv.some(token => object(token) && "json" in token);
      const properties = object(op.inputSchema.properties) ? op.inputSchema.properties : {};
      const bound = new Set(op.argv.flatMap(token => object(token) && "parameter" in token ? [token.parameter] : []));
      requireThat(whole || op.inputSchema.additionalProperties === false && Object.keys(properties).every(key => bound.has(key)), "CLI 参数必须全部绑定 argv 或 JSON 输入。");
    } else requireThat(op.argv === undefined && op.stdin === undefined, "MCP 不使用 argv 或 stdin 绑定。");
  }
  return new Provider(provider);
}

/** Keep class prototypes out of persisted data and connection identity. */
export function providerData(provider: Provider): Params {
  return structuredClone({ ...provider, operations: provider.operations.map(operation => ({ ...operation })) }) as unknown as Params;
}

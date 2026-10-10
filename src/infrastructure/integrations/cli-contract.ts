import { AssistantError } from "../../application/ports.js";
import { object, type Parameters } from "../../domain/shared.js";
import { parseCliConnection, type CliConnectionConfig } from "./connection-config.js";
import { parseOperationContract, type OperationContract } from "./operation-contract.js";

export interface CliBinding {
  /** Fixed arguments, one JSON input, or explicit scalar fields. No shell. */
  argv: (string | { parameters: "json" } | { parameter: string })[];
  stdin?: "json";
}
export interface CliOperation extends OperationContract, CliBinding { schema: Parameters }
export interface CliConfig extends CliConnectionConfig { operations: CliOperation[] }
function invalid(): never { throw new AssistantError("INVALID_CLI_CONTRACT", "CLI 调用约定无效；需要绝对入口、明确参数、执行要求和可校验 schema。"); }

/** Missing bindings stay absent; only CLI connections require them. */
export function parseCliBinding(value: unknown, inputSchema?: Parameters): Partial<CliBinding> {
  if (!object(value) || Object.keys(value).some(key => !["argv", "stdin"].includes(key)) ||
      value.stdin !== undefined && value.stdin !== "json") invalid();
  const stdin = value.stdin === "json" ? { stdin: "json" as const } : {};
  if (value.argv === undefined) return stdin;
  if (!Array.isArray(value.argv)) invalid();
  const argv = value.argv.map(token => {
    if (typeof token === "string" && !token.includes("\0")) return token;
    if (!object(token) || Object.keys(token).length !== 1) invalid();
    if (token.parameters === "json") return { parameters: "json" as const };
    if (typeof token.parameter === "string" && token.parameter && !token.parameter.includes("\0")) return { parameter: token.parameter };
    return invalid();
  });
  const jsonChannels = argv.filter(token => typeof token !== "string" && "parameters" in token).length + (value.stdin === "json" ? 1 : 0);
  const fields = argv.flatMap(token => typeof token !== "string" && "parameter" in token ? [token.parameter] : []);
  if (jsonChannels > 1 || jsonChannels && fields.length) invalid();
  if (!jsonChannels) {
    // Each accepted parameter needs an explicit binding. Do not ignore input fields.
    const properties = inputSchema?.properties ?? {};
    if (!object(properties) || inputSchema?.additionalProperties !== false || new Set(fields).size !== fields.length ||
        Object.keys(properties).length !== fields.length || fields.some(field => !Object.hasOwn(properties, field) ||
          !object(properties[field]) || !["string", "number", "integer", "boolean"].includes(String(properties[field].type))) ||
        fields.length && (!Array.isArray(inputSchema.required) || fields.some(field => !(inputSchema.required as unknown[]).includes(field)))) invalid();
  }
  return { argv, ...stdin };
}
export function parseCliConfig(value: unknown): CliConfig {
  if (!object(value) || !Array.isArray(value.operations)) invalid();
  const { operations: input, ...settings } = value;
  const connection = parseCliConnection(settings), names = new Set<string>();
  const operations = input.map(item => {
    if (!object(item) || typeof item.description !== "string") invalid();
    const { argv, stdin, ...common } = item;
    const operation = parseOperationContract(common);
    if (!operation.schema || names.has(operation.name)) invalid();
    names.add(operation.name);
    const binding = parseCliBinding({ argv, stdin }, operation.schema);
    if (!binding.argv) invalid();
    return { ...operation, ...binding, schema: operation.schema, argv: binding.argv };
  });
  return { ...connection, operations };
}

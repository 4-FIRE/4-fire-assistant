import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { AssistantError } from "../../application/ports.js";
import type { Parameters } from "../../domain/shared.js";

export function compileToolSchema(value: Parameters): ValidateFunction {
  try {
    const dialect = value.$schema;
    const ajv = typeof dialect === "string" && dialect.includes("2020-12") ? new Ajv2020({ strict: true }) :
      typeof dialect === "string" && dialect.includes("2019-09") ? new Ajv2019({ strict: true }) : new Ajv({ strict: true });
    addFormats.default(ajv); return ajv.compile(value);
  }
  catch { throw new AssistantError("INVALID_CLI_CONTRACT", "工具 schema 无效或不受支持。"); }
}

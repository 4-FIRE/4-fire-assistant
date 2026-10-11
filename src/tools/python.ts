import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { json } from "../common/json.js";
import type { ResearchService } from "../services/research-service.js";
import type { CallAccess } from "./access.js";
import { result } from "./result.js";

export function pythonTool(service: Pick<ResearchService, "run">, access: CallAccess) {
  return defineTool({
    name: "ffa_python", label: "Python 实验",
    description: "运行 Python 并保存源码、输入和结果。owner 可为 projects/名称 或 areas/名称，省略写入 scratch。环境、产物与可选计算库见 FFA 包内资料根目录下 references/compute.md。不是沙箱。",
    outputSchema: Type.Object({ id: Type.String(), path: Type.String(),
      state: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]), output: Type.Unknown() }),
    parameters: Type.Object({ code: Type.String({ minLength: 1, maxLength: 262144 }), inputs: Type.Optional(Type.Unknown()), owner: Type.Optional(Type.String()) }),
    async execute(_id, args, signal) {
      access.check(true);
      const value = await service.run({ code: args.code, inputs: json(args.inputs ?? null),
        ...(args.owner ? { owner: args.owner } : {}) }, access.signal(signal));
      const text = JSON.stringify(value.output);
      return result({ ...value, output: text.length > 16000 ? { preview: text.slice(0, 16000), truncated: true } : value.output }, value.state !== "completed");
    },
  });
}

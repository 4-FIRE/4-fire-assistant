import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ReviewDecision } from "../services/expert-service.js";
import type { CallAccess } from "./access.js";
import { name } from "./schemas/input.js";
import { result } from "./result.js";

export function submitReviewTool(submit: (decision: ReviewDecision) => void, access: CallAccess) {
  return defineTool({
    name: "ffa_submit_review", label: "登记独立复核", executionMode: "sequential",
    description: "登记本次精确方案的复核决定。通过时必须引用本专家实际取得的查询回执。",
    outputSchema: Type.Object({ approved: Type.Boolean() }),
    parameters: Type.Object({ approved: Type.Boolean(), evidenceIds: Type.Array(name), note: Type.String({ minLength: 1 }) }),
    async execute(_id, decision) {
      access.check(true); submit(decision); return result({ approved: decision.approved });
    },
  });
}

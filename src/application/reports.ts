import { AssistantError } from "./ports.js";
import type { Evidence, Scope } from "../domain/shared.js";
import type { Report } from "./business-ports.js";
export interface ReportPort { get(ownerId: number, ref: string): Promise<Report | Evidence | undefined> }
export class ReportService {
  constructor(private readonly port: ReportPort) {}
  async read(scope: Scope, ref: string, allowedRefs: readonly string[], offset = 0, limit = 8000) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000) {
      throw new AssistantError("REPORT_WINDOW", "报告读取窗口为非负 offset、1–16000 字符 limit。");
    }
    const value = await this.port.get(scope.ownerId, ref);
    if (!value) throw new AssistantError("REPORT_UNAVAILABLE", "本主会话没有该引用；不能跨会话读取。");
    if (scope.role !== "coordinator" && !allowedRefs.includes(ref) && !("scope" in value &&
        value.scope.conversationId === scope.conversationId && value.scope.roundId === scope.roundId)) {
      throw new AssistantError("REPORT_DENIED", "该引用未提供给本次专家委派。");
    }
    const text = "content" in value ? value.content : JSON.stringify(value, null, 2);
    return { ref, text: text.slice(offset, offset + limit), offset, nextOffset: offset + limit < text.length ? offset + limit : null,
      totalChars: text.length, metadata: "content" in value ? { role: value.role, createdAt: value.createdAt, status: value.status,
        sources: value.evidence.map(e => ({ ref: e.ref, operation: e.operation, obtainedAt: e.obtainedAt, success: e.success })) } :
        { operation: value.operation, obtainedAt: value.obtainedAt, success: value.success } };
  }
}

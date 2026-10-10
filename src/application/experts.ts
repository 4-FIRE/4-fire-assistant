import { builtInPermissions, type RolePermissions } from "./permissions.js";
import { AssistantError } from "./ports.js";
import type { Report } from "./business-ports.js";
import type { Scope, Role } from "../domain/shared.js";

export interface DelegationInput { role: Role; goal: string; expertId?: string; reportRefs?: string[]; intentId?: string }
export interface DelegatedWork { key: string; expertId: string; roundId: string }
export interface ExpertPort {
  reserve(scope: Scope, key: string, input: DelegationInput): Promise<DelegatedWork>;
  deliver(work: DelegatedWork): Promise<void>;
  collect(work: DelegatedWork): Promise<Report>;
}
/** Selection is the coordinator's choice; this service imposes no role singleton. */
export class ExpertService {
  constructor(private readonly port: ExpertPort, private readonly roles: RolePermissions = builtInPermissions) {}
  async delegate(scope: Scope, key: string, input: DelegationInput): Promise<Report> {
    if (scope.role !== "coordinator" || input.role === "coordinator" || !Object.hasOwn(this.roles, input.role)) throw new AssistantError("DELEGATION_DENIED", "只有协调者能委派已启用的专家角色。");
    if (!input.goal.trim()) throw new AssistantError("DELEGATION_EMPTY", "委派必须提供本轮目标。");
    const work = await this.port.reserve(scope, key, input);
    await this.port.deliver(work);
    return this.port.collect(work);
  }
}

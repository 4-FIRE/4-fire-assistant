import type { Json } from "../domain/shared.js";
import type { ExpertSummary } from "./business-ports.js";

/** Application contracts intentionally do not expose SDK handles or credentials. */
export class AssistantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AssistantError";
  }
}
export interface AuthenticationInteraction {
  signal: AbortSignal;
  ask(message: string, secret: boolean, choices?: readonly { id: string; label: string }[], signal?: AbortSignal): Promise<string>;
  notify(message: string): void;
}
export interface ModelSelection { provider: string; modelId: string }
export interface ConversationSummary { id: string; title: string }
export interface TranscriptMessage { id: string; role: "user" | "assistant"; text: string }
export interface WorkSummary {
  requestId: string;
  content?: string;
  status: "admitting" | "running" | "answered" | "unanswered" | "cancelled";
}
export interface CommittedView {
  conversation: ConversationSummary;
  messages: readonly TranscriptMessage[];
  partial: string;
  working: boolean;
  activity?: string;
}
export interface RuntimeStatus {
  conversation: ConversationSummary;
  work: WorkSummary | null;
  needsContinuation: boolean;
  blocked: readonly string[];
  unfinishedTasks: number;
  business?: Json;
  usage?: Json;
}
export interface RunResult { requestId: string; status: "answered" | "unanswered" | "cancelled" }
export interface RuntimePort {
  status(): Promise<RuntimeStatus>;
  sessions(): Promise<readonly ConversationSummary[]>;
  intents(): Promise<readonly Json[]>;
  resolveIntent(id: string, revision: number, note: string): Promise<Json>;
  revoke(): void | Promise<void>;
  experts(): Promise<readonly ExpertSummary[]>;
  submit(content: string): Promise<RunResult>;
  continueWork(): Promise<RunResult>;
  cancel(): Promise<void>;
  newSession(title?: string): Promise<ConversationSummary>;
  selectSession(id: string): Promise<ConversationSummary>;
  observe(listener: (view: CommittedView) => void | Promise<void>): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

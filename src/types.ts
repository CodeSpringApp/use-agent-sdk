export type TurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentEvent {
  schemaVersion: 1;
  id: number;
  sessionId: string;
  turnId?: string;
  attempt: number;
  type: string;
  createdAt: string;
  data: unknown;
}

export interface SessionSnapshot {
  sessionId: string;
  agentRevisionId: string;
  createdAt: string;
  updatedAt: string;
  cursor: number;
  turns: Array<{
    id: string;
    status: TurnStatus;
    attempt: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface CreateSessionResponse {
  sessionId: string;
  agentRevisionId: string;
  createdAt: string;
}

export interface SubmitTurnResponse {
  sessionId: string;
  turnId: string;
  status: TurnStatus;
  cursor: number;
  duplicate: boolean;
}

export interface ListEventsResponse {
  events: AgentEvent[];
  cursor: number;
  hasMore: boolean;
}

/** Tenant-scoped model profile configured in the CodeSpring control plane. */
export type ModelProfileId = string;

export interface AgentToolReference {
  name: string;
  description?: string;
}

export interface AgentMcpServerReference {
  id: string;
  allowedTools?: string[];
}

export interface AgentSkillReference {
  id: string;
  version?: string;
}

export interface AgentDefinition {
  readonly id: string;
  readonly revision: string;
  readonly revisionId: string;
  readonly instructions?: string;
  readonly model?: ModelProfileId;
  readonly tools: readonly AgentToolReference[];
  readonly mcpServers: readonly AgentMcpServerReference[];
  readonly skills: readonly AgentSkillReference[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CreateAgentOptions {
  id: string;
  revision: string;
  instructions?: string;
  model?: ModelProfileId;
  tools?: AgentToolReference[];
  mcpServers?: AgentMcpServerReference[];
  skills?: AgentSkillReference[];
  metadata?: Record<string, string>;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SubmitOptions extends RequestOptions {
  idempotencyKey?: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AgentClientOptions {
  endpoint: string;
  apiKey: string;
  fetch?: FetchLike;
}

export interface BrowserAgentClientOptions {
  endpoint: string;
  getClientToken: () => Promise<string>;
  fetch?: FetchLike;
}

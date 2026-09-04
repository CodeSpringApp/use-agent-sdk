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

export interface CreateWebSocketTicketResponse {
  ticket: string;
  expiresAt: string;
}

export type WebSocketServerMessage =
  | { type: "event"; event: AgentEvent }
  | { type: "replay.completed"; cursor: number; hasMore: boolean }
  | { type: "error"; code: string; message: string };

export interface AgentWebSocketEventMap {
  open: Event;
  message: MessageEvent;
  error: Event;
  close: CloseEvent;
}

export interface AgentWebSocket {
  readonly readyState: number;
  addEventListener<K extends keyof AgentWebSocketEventMap>(
    type: K,
    listener: (event: AgentWebSocketEventMap[K]) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type AgentWebSocketFactory = (url: string) => AgentWebSocket;

export interface AgentConnectionOptions {
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onReplayComplete?: (cursor: number) => void;
  onError?: (error: Error) => void;
  onClose?: (event: CloseEvent) => void;
}

export interface AgentConnection {
  readonly cursor: number;
  close(code?: number, reason?: string): void;
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
  attachments?: ExternalAssetRef[];
}

export interface ExternalAssetRef {
  kind: "external";
  assetId: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  sizeBytes: number;
  sha256?: string;
}

export interface AgentAssetResolver {
  type: "customer_hosted";
  endpoint: string;
  handlerRevision: string;
}

export interface PageOptions extends RequestOptions {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export type ManagedAgentStatus = "active" | "archived";
export type ManagedToolStatus = "active" | "disabled";

export interface ManagedAgentSummary {
  agentId: string;
  displayName: string;
  description: string;
  modelProfileId: string;
  assetResolver: AgentAssetResolver | null;
  status: ManagedAgentStatus;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedAgentRevision {
  revisionId: string;
  revisionNumber: number;
  agentId: string;
  displayName: string;
  description: string;
  instructions: string;
  modelProfileId: string;
  modelProfileRevisionId: string;
  maxModelSteps: number;
  maxToolCalls: number;
  tools: Array<{ toolId: string; revisionId: string; modelName: string }>;
  mcpTools: Array<{
    serverId: string;
    snapshotId: string;
    sourceName: string;
    modelName: string;
  }>;
  skills: Array<{ skillId: string; revisionId: string }>;
  assetResolver: AgentAssetResolver | null;
  createdAt: string;
}

export interface ManagedAgent extends ManagedAgentSummary {
  instructions: string;
  toolIds: string[];
  mcpToolIds: string[];
  skillIds: string[];
  currentRevision: ManagedAgentRevision | null;
  hasUnpublishedChanges: boolean;
}

export interface AgentDraftInput {
  operationId?: string;
  displayName: string;
  description?: string;
  instructions: string;
  modelProfileId: string;
  toolIds?: string[];
  mcpToolIds?: string[];
  skillIds?: string[];
  assetResolver?: AgentAssetResolver | null;
}

export interface CreateManagedAgentInput extends AgentDraftInput {
  agentId: string;
}

export type ManagedToolTransport =
  | { type: "https_get"; endpoint: string }
  | { type: "customer_hosted"; endpoint: string; handlerRevision: string };

export interface ManagedToolRevision {
  revisionId: string;
  revisionNumber: number;
  toolId: string;
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  transport: ManagedToolTransport;
  timeoutMs: number;
  maxResponseBytes: number;
  risk: "read" | "write";
  effectClass: "read" | "idempotent_write";
  createdAt: string;
}

export interface ManagedTool {
  toolId: string;
  displayName: string;
  status: ManagedToolStatus;
  currentRevisionId: string;
  currentRevision: ManagedToolRevision;
  createdAt: string;
  updatedAt: string;
}

export interface ToolRevisionInput {
  operationId?: string;
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  transport: ManagedToolTransport;
  risk?: "read" | "write";
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface CreateManagedToolInput {
  operationId?: string;
  toolId: string;
  displayName: string;
  initialRevision: Omit<ToolRevisionInput, "operationId">;
}

export type ManagedMcpServerStatus = "active" | "disabled" | "error";
export type ManagedMcpAuthMode = "none" | "bearer" | "header";
export type ManagedMcpAuthConnectionStatus =
  | "pending_validation"
  | "active"
  | "invalid"
  | "revoked";
export interface ManagedMcpAuthConnection {
  connectionId: string;
  label: string;
  mode: Exclude<ManagedMcpAuthMode, "none">;
  headerName: string | null;
  status: ManagedMcpAuthConnectionStatus;
  displayHint: string | null;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastUsedAt: string | null;
}
export interface CreateManagedMcpAuthConnectionInput {
  operationId?: string;
  label: string;
  mode: Exclude<ManagedMcpAuthMode, "none">;
  headerName?: string | null;
  secret: string;
}
export interface RotateManagedMcpAuthConnectionInput {
  operationId?: string;
  secret: string;
}
export interface ManagedMcpTool {
  toolId: string;
  sourceName: string;
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ManagedMcpSnapshot {
  snapshotId: string;
  snapshotNumber: number;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  toolsDigest: string;
  tools: ManagedMcpTool[];
  createdAt: string;
}
export interface ManagedMcpServer {
  serverId: string;
  displayName: string;
  endpoint: string;
  authMode: ManagedMcpAuthMode;
  authConnection: ManagedMcpAuthConnection | null;
  status: ManagedMcpServerStatus;
  currentSnapshotId: string | null;
  currentSnapshot: ManagedMcpSnapshot | null;
  lastErrorCode: string | null;
  lastDiscoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CreateManagedMcpServerInput {
  operationId?: string;
  serverId: string;
  displayName: string;
  endpoint: string;
  authMode?: ManagedMcpAuthMode;
  authConnectionId?: string | null;
}
export interface CreateAuthenticatedManagedMcpServerInput
  extends Omit<CreateManagedMcpServerInput, "authMode" | "authConnectionId"> {
  authentication: {
    label?: string;
    mode: Exclude<ManagedMcpAuthMode, "none">;
    headerName?: string | null;
    secret: string;
  };
}

export type ManagedSkillStatus = "active" | "disabled";
export type ManagedSkillFileKind = "instructions" | "reference" | "asset" | "script" | "other";
export interface ManagedSkillPackageFileInput { path: string; contentBase64: string; mediaType?: string }
export interface ManagedSkillPackageInput { files: ManagedSkillPackageFileInput[] }
export interface ManagedSkillFile {
  path: string;
  kind: ManagedSkillFileKind;
  mediaType: string;
  digest: string;
  bytes: number;
  text: boolean;
}
export interface ManagedSkillRevision {
  revisionId: string;
  revisionNumber: number;
  skillId: string;
  format: "agentskills.io/v1";
  packageDigest: string;
  packageBytes: number;
  fileCount: number;
  instructionsDigest: string;
  instructionsBytes: number;
  contextBudgetChars: number;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string | null;
  source: "tenant_upload" | "codespring_catalogue";
  sourceId: string | null;
  sourceVersion: string | null;
  publisher: string | null;
  diagnostics: string[];
  createdAt: string;
}
export interface ManagedSkillSummary {
  skillId: string;
  displayName: string;
  description: string;
  status: ManagedSkillStatus;
  currentRevisionId: string;
  currentRevision: ManagedSkillRevision;
  createdAt: string;
  updatedAt: string;
}
export interface ManagedSkill extends ManagedSkillSummary {
  skillMd: string;
  files: ManagedSkillFile[];
}
export interface CreateManagedSkillInput {
  operationId?: string;
  package: ManagedSkillPackageInput;
  contextBudgetChars?: number;
}
export interface SkillRevisionInput {
  operationId?: string;
  package: ManagedSkillPackageInput;
  contextBudgetChars?: number;
}
export interface ManagedSkillPackagePreview extends Omit<ManagedSkillRevision, "revisionId" | "revisionNumber" | "skillId" | "fileCount" | "instructionsDigest" | "instructionsBytes" | "contextBudgetChars" | "source" | "sourceId" | "sourceVersion" | "publisher" | "createdAt"> {
  displayName: string;
  files: ManagedSkillFile[];
}
export interface ManagedSkillFileContent { file: ManagedSkillFile; text: string | null; contentBase64: string | null }
export interface ManagedSkillCatalogueSummary {
  catalogueId: string;
  version: string;
  publisher: string;
  category: string;
  summary: string;
  packageDigest: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string | null;
}
export interface ManagedSkillCatalogueEntry extends ManagedSkillCatalogueSummary { files: ManagedSkillFile[] }
export interface InstallManagedSkillCatalogueInput { operationId?: string; version?: string; contextBudgetChars?: number }

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AgentClientOptions {
  endpoint: string;
  apiKey: string;
  fetch?: FetchLike;
}

export interface BrowserAgentClientOptions {
  endpoint: string;
  getClientToken: () => Promise<ClientTokenResult>;
  /** Fallback lifetime for opaque legacy tokens without an expiry. Defaults to 60 seconds. */
  clientTokenTtlMs?: number;
  /** Refresh before expiry. Defaults to 30 seconds and is bounded for short tokens. */
  refreshSkewMs?: number;
  fetch?: FetchLike;
  /** Injectable for tests or non-DOM browser runtimes. Defaults to the global WebSocket constructor. */
  webSocket?: AgentWebSocketFactory;
}

export type ClientTokenResult =
  | string
  | {
      token: string;
      /** ISO timestamp or Unix time in seconds/milliseconds. */
      expiresAt?: string | number;
    };

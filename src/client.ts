import type {
  AgentDefinition,
  AgentConnection,
  AgentConnectionOptions,
  BrowserAgentClientOptions,
  CreateWebSocketTicketResponse,
  CreateSessionResponse,
  FetchLike,
  ListEventsResponse,
  RequestOptions,
  SessionSnapshot,
  SubmitOptions,
  SubmitTurnResponse,
  AgentClientOptions,
  AgentEvent,
  AgentWebSocketFactory,
  ClientTokenResult,
  CreateManagedAgentInput,
  CreateManagedToolInput,
  ManagedAgent,
  ManagedAgentRevision,
  ManagedAgentSummary,
  ManagedAgentStatus,
  ManagedToolStatus,
  ManagedTool,
  Page,
  PageOptions,
  ToolRevisionInput,
  AgentDraftInput,
  WebSocketServerMessage,
  ManagedMcpServer,
  ManagedMcpServerStatus,
  CreateManagedMcpServerInput,
  CreateAuthenticatedManagedMcpServerInput,
  CreateManagedMcpAuthConnectionInput,
  RotateManagedMcpAuthConnectionInput,
  ManagedMcpAuthConnection,
  ManagedSkill,
  ManagedSkillSummary,
  ManagedSkillStatus,
  CreateManagedSkillInput,
  SkillRevisionInput,
} from "./types";

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

interface TokenProvider {
  get: () => Promise<string>;
  invalidate: () => boolean;
}

interface TransportOptions {
  endpoint: string;
  token: TokenProvider;
  fetch?: FetchLike;
  webSocket?: AgentWebSocketFactory;
  browser: boolean;
}

class Transport {
  readonly endpoint: string;
  readonly fetchImplementation: FetchLike;

  constructor(private readonly options: TransportOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) throw new TypeError("A fetch implementation is required");
    this.fetchImplementation = options.fetch
      ? fetchImplementation
      : fetchImplementation.bind(globalThis);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response = await this.fetchWithToken(path, init);
    if (response.status === 401 && this.options.token.invalidate()) {
      response = await this.fetchWithToken(path, init);
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const payload = await readJson(response);
    if (!response.ok) {
      const error = isObject(payload) && isObject(payload.error) ? payload.error : undefined;
      throw new AgentError(
        typeof error?.message === "string" ? error.message : `Use Agent request failed with ${response.status}`,
        response.status,
        typeof error?.code === "string" ? error.code : "request_failed",
        requestId,
        error?.details,
      );
    }
    return payload as T;
  }

  async connectSession(
    sessionId: string,
    options: AgentConnectionOptions,
  ): Promise<AgentConnection> {
    if (!this.options.browser) {
      throw new TypeError("Browser WebSocket connections require createBrowserClient");
    }
    const after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("after must be a non-negative safe integer");
    }
    const issued = await this.request<CreateWebSocketTicketResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/websocket-tickets`,
      {
        method: "POST",
        body: JSON.stringify({ after }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const socketUrl = new URL(
      `${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/connect`,
    );
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("ticket", issued.ticket);
    const createSocket = this.options.webSocket ?? defaultWebSocketFactory;
    const socket = createSocket(socketUrl.toString());
    let cursor = after;
    let opened = false;
    let settled = false;

    return new Promise<AgentConnection>((resolve, reject) => {
      const connection: AgentConnection = {
        get cursor() {
          return cursor;
        },
        close: (code = 1000, reason = "client closed") => socket.close(code, reason),
      };
      const failBeforeOpen = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.addEventListener("open", () => {
        opened = true;
        if (settled) return;
        settled = true;
        resolve(connection);
      });
      socket.addEventListener("message", (message) => {
        try {
          const parsed = parseWebSocketServerMessage(message.data);
          if (parsed.type === "event") {
            cursor = Math.max(cursor, parsed.event.id);
            options.onEvent(parsed.event);
            return;
          }
          if (parsed.type === "replay.completed") {
            cursor = Math.max(cursor, parsed.cursor);
            if (parsed.hasMore) {
              socket.send(JSON.stringify({ type: "replay", after: cursor }));
            } else {
              options.onReplayComplete?.(cursor);
            }
            return;
          }
          const error = new AgentError(parsed.message, 0, parsed.code);
          options.onError?.(error);
          socket.close(1008, "server rejected connection");
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          options.onError?.(normalized);
          socket.close(1008, "invalid server message");
          if (!opened) failBeforeOpen(normalized);
        }
      });
      socket.addEventListener("error", () => {
        const error = new AgentError("WebSocket connection failed", 0, "websocket_failed");
        options.onError?.(error);
        if (!opened) failBeforeOpen(error);
      });
      socket.addEventListener("close", (event) => {
        options.onClose?.(event);
        if (!opened) {
          failBeforeOpen(
            new AgentError(
              "WebSocket closed before connecting",
              0,
              "websocket_closed",
            ),
          );
        }
      });
      if (options.signal) {
        const closeForAbort = () => socket.close(1000, "request aborted");
        if (options.signal.aborted) closeForAbort();
        else options.signal.addEventListener("abort", closeForAbort, { once: true });
      }
    });
  }

  private async fetchWithToken(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${await this.options.token.get()}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    return this.fetchImplementation(`${this.endpoint}${path}`, { ...init, headers });
  }
}

function jwtExpiry(token: string): number | undefined {
  const encoded = token.split(".")[1];
  if (!encoded || typeof globalThis.atob !== "function") return undefined;
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const payload = JSON.parse(globalThis.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

function explicitExpiry(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return value < 1_000_000_000_000 ? value * 1_000 : value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

class CachedTokenProvider implements TokenProvider {
  private cached: { token: string; refreshAt: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly load: () => Promise<ClientTokenResult>,
    private readonly fallbackTtlMs: number,
    private readonly refreshSkewMs: number,
  ) {}

  get = async (): Promise<string> => {
    if (this.cached && Date.now() < this.cached.refreshAt) return this.cached.token;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  };

  invalidate = () => {
    this.cached = undefined;
    return true;
  };

  private async refresh(): Promise<string> {
    const loaded = await this.load();
    const token = typeof loaded === "string" ? loaded : loaded.token;
    if (!token.trim()) throw new TypeError("getClientToken returned an empty token");
    const now = Date.now();
    const expiry =
      (typeof loaded === "string" ? undefined : explicitExpiry(loaded.expiresAt)) ??
      jwtExpiry(token) ??
      now + this.fallbackTtlMs;
    const lifetime = Math.max(1_000, expiry - now);
    this.cached = {
      token,
      refreshAt: expiry - Math.min(this.refreshSkewMs, Math.max(500, lifetime / 2)),
    };
    return token;
  }
}

const staticTokenProvider = (token: string): TokenProvider => ({
  get: async () => token,
  invalidate: () => false,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) return undefined;
    throw new AgentError("Runtime returned a non-JSON response", response.status, "invalid_response");
  }
  return response.json();
}

function normalizeEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new TypeError("endpoint must use HTTPS outside local development");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

const randomIdempotencyKey = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("crypto.randomUUID is required when no idempotency key is supplied");
};

export class AgentSession {
  constructor(
    private readonly transport: Transport,
    public readonly id: string,
  ) {}

  get(options: RequestOptions = {}): Promise<SessionSnapshot> {
    return this.transport.request(`/v1/sessions/${encodeURIComponent(this.id)}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  submit(content: string, options: SubmitOptions = {}): Promise<SubmitTurnResponse> {
    const idempotencyKey = options.idempotencyKey ?? randomIdempotencyKey();
    return this.transport.request(`/v1/sessions/${encodeURIComponent(this.id)}/turns`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ content, attachments: options.attachments ?? [] }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  events(after = 0, limit = 100, options: RequestOptions = {}): Promise<ListEventsResponse> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.transport.request(`/v1/sessions/${encodeURIComponent(this.id)}/events?${query}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async cancel(turnId: string, options: RequestOptions = {}): Promise<TurnStatusResponse> {
    return this.transport.request(
      `/v1/sessions/${encodeURIComponent(this.id)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {
        method: "POST",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  }

  connect(options: AgentConnectionOptions): Promise<AgentConnection> {
    return this.transport.connectSession(this.id, options);
  }
}

export interface TurnStatusResponse {
  sessionId: string;
  turnId: string;
  status: string;
}

export class AgentClient {
  constructor(private readonly transport: Transport) {}

  readonly sessions = {
    create: async (agent: AgentDefinition, options: RequestOptions = {}): Promise<AgentSession> => {
      const created = await this.transport.request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ agentRevisionId: agent.revisionId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return new AgentSession(this.transport, created.sessionId);
    },
    get: (sessionId: string): AgentSession => new AgentSession(this.transport, sessionId),
  };

  readonly agents = {
    list: (options: PageOptions = {}): Promise<Page<ManagedAgentSummary>> =>
      this.transport.request(`/v1/agents${pageQuery(options)}`, requestInit(options)),
    get: (agentId: string, options: RequestOptions = {}): Promise<ManagedAgent> =>
      this.transport.request(
        `/v1/agents/${encodeURIComponent(agentId)}`,
        requestInit(options),
      ),
    revisions: (
      agentId: string,
      options: PageOptions = {},
    ): Promise<Page<ManagedAgentRevision>> =>
      this.transport.request(
        `/v1/agents/${encodeURIComponent(agentId)}/revisions${pageQuery(options)}`,
        requestInit(options),
      ),
    create: (
      input: CreateManagedAgentInput,
      options: RequestOptions = {},
    ): Promise<ManagedAgent> =>
      this.transport.request("/v1/agents", {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    updateDraft: (
      agentId: string,
      input: AgentDraftInput,
      options: RequestOptions = {},
    ): Promise<ManagedAgent> =>
      this.transport.request(`/v1/agents/${encodeURIComponent(agentId)}`, {
        method: "PUT",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    publish: (agentId: string, options: RequestOptions = {}): Promise<ManagedAgent> =>
      this.transport.request(`/v1/agents/${encodeURIComponent(agentId)}/publish`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey() }),
        ...requestInit(options),
      }),
    setStatus: (
      agentId: string,
      status: ManagedAgentStatus,
      options: RequestOptions = {},
    ): Promise<ManagedAgent> =>
      this.transport.request(`/v1/agents/${encodeURIComponent(agentId)}/status`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey(), status }),
        ...requestInit(options),
      }),
  };

  readonly tools = {
    list: (options: PageOptions = {}): Promise<Page<ManagedTool>> =>
      this.transport.request(`/v1/tools${pageQuery(options)}`, requestInit(options)),
    get: (toolId: string, options: RequestOptions = {}): Promise<ManagedTool> =>
      this.transport.request(
        `/v1/tools/${encodeURIComponent(toolId)}`,
        requestInit(options),
      ),
    create: (
      input: CreateManagedToolInput,
      options: RequestOptions = {},
    ): Promise<ManagedTool> =>
      this.transport.request("/v1/tools", {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    publish: (
      toolId: string,
      input: ToolRevisionInput,
      options: RequestOptions = {},
    ): Promise<ManagedTool> =>
      this.transport.request(`/v1/tools/${encodeURIComponent(toolId)}/publish`, {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    setStatus: (
      toolId: string,
      status: ManagedToolStatus,
      options: RequestOptions = {},
    ): Promise<ManagedTool> =>
      this.transport.request(`/v1/tools/${encodeURIComponent(toolId)}/status`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey(), status }),
        ...requestInit(options),
      }),
  };

  readonly mcpAuthConnections = {
    list: (options: PageOptions = {}): Promise<Page<ManagedMcpAuthConnection>> =>
      this.transport.request(`/v1/mcp-auth-connections${pageQuery(options)}`, requestInit(options)),
    get: (connectionId: string, options: RequestOptions = {}): Promise<ManagedMcpAuthConnection> =>
      this.transport.request(`/v1/mcp-auth-connections/${encodeURIComponent(connectionId)}`, requestInit(options)),
    create: (input: CreateManagedMcpAuthConnectionInput, options: RequestOptions = {}): Promise<ManagedMcpAuthConnection> =>
      this.transport.request("/v1/mcp-auth-connections", {
        method: "POST",
        body: JSON.stringify(withOperationId({ headerName: null, ...input })),
        ...requestInit(options),
      }),
    rotate: (connectionId: string, input: RotateManagedMcpAuthConnectionInput, options: RequestOptions = {}): Promise<ManagedMcpAuthConnection> =>
      this.transport.request(`/v1/mcp-auth-connections/${encodeURIComponent(connectionId)}/rotate`, {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    revoke: (connectionId: string, options: RequestOptions = {}): Promise<ManagedMcpAuthConnection> =>
      this.transport.request(`/v1/mcp-auth-connections/${encodeURIComponent(connectionId)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey() }),
        ...requestInit(options),
      }),
  };

  readonly mcpServers = {
    list: (options: PageOptions = {}): Promise<Page<ManagedMcpServer>> =>
      this.transport.request(`/v1/mcp-servers${pageQuery(options)}`, requestInit(options)),
    get: (serverId: string, options: RequestOptions = {}): Promise<ManagedMcpServer> =>
      this.transport.request(`/v1/mcp-servers/${encodeURIComponent(serverId)}`, requestInit(options)),
    create: (input: CreateManagedMcpServerInput, options: RequestOptions = {}): Promise<ManagedMcpServer> =>
      this.transport.request("/v1/mcp-servers", {
        method: "POST",
        body: JSON.stringify(withOperationId({ authMode: "none" as const, authConnectionId: null, ...input })),
        ...requestInit(options),
      }),
    createAuthenticated: async (
      input: CreateAuthenticatedManagedMcpServerInput,
      options: RequestOptions = {},
    ): Promise<ManagedMcpServer> => {
      const { authentication, ...server } = input;
      const connection = await this.mcpAuthConnections.create({
        label: authentication.label ?? `${server.displayName} credential`,
        mode: authentication.mode,
        headerName: authentication.headerName ?? null,
        secret: authentication.secret,
      }, options);
      try {
        return await this.mcpServers.create({
          ...server,
          authMode: authentication.mode,
          authConnectionId: connection.connectionId,
        }, options);
      } catch (error) {
        await this.mcpAuthConnections.revoke(connection.connectionId, options).catch(() => undefined);
        throw error;
      }
    },
    refresh: (serverId: string, options: RequestOptions = {}): Promise<ManagedMcpServer> =>
      this.transport.request(`/v1/mcp-servers/${encodeURIComponent(serverId)}/refresh`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey() }),
        ...requestInit(options),
      }),
    setStatus: (serverId: string, status: Exclude<ManagedMcpServerStatus, "error">, options: RequestOptions = {}): Promise<ManagedMcpServer> =>
      this.transport.request(`/v1/mcp-servers/${encodeURIComponent(serverId)}/status`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey(), status }),
        ...requestInit(options),
      }),
  };

  readonly skills = {
    list: (options: PageOptions = {}): Promise<Page<ManagedSkillSummary>> =>
      this.transport.request(`/v1/skills${pageQuery(options)}`, requestInit(options)),
    get: (skillId: string, options: RequestOptions = {}): Promise<ManagedSkill> =>
      this.transport.request(`/v1/skills/${encodeURIComponent(skillId)}`, requestInit(options)),
    create: (input: CreateManagedSkillInput, options: RequestOptions = {}): Promise<ManagedSkill> =>
      this.transport.request("/v1/skills", {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    publish: (skillId: string, input: SkillRevisionInput, options: RequestOptions = {}): Promise<ManagedSkill> =>
      this.transport.request(`/v1/skills/${encodeURIComponent(skillId)}/publish`, {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    setStatus: (skillId: string, status: ManagedSkillStatus, options: RequestOptions = {}): Promise<ManagedSkill> =>
      this.transport.request(`/v1/skills/${encodeURIComponent(skillId)}/status`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey(), status }),
        ...requestInit(options),
      }),
  };
}

function pageQuery(options: PageOptions): string {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const value = query.toString();
  return value ? `?${value}` : "";
}

function requestInit(options: RequestOptions): RequestInit {
  return options.signal === undefined ? {} : { signal: options.signal };
}

function withOperationId<T extends { operationId?: string }>(input: T): T & { operationId: string } {
  return { ...input, operationId: input.operationId ?? randomIdempotencyKey() };
}

/** Server entrypoint. Never pass this client or its API key into a browser bundle. */
export function createClient(options: AgentClientOptions): AgentClient {
  if (!options.apiKey.trim()) throw new TypeError("apiKey is required");
  return new AgentClient(
    new Transport({
      endpoint: options.endpoint,
      token: staticTokenProvider(options.apiKey),
      browser: false,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  );
}

/** Browser-safe client used by the React subpath with short-lived client tokens. */
export function createBrowserClient(options: BrowserAgentClientOptions): AgentClient {
  return new AgentClient(
    new Transport({
      endpoint: options.endpoint,
      token: new CachedTokenProvider(
        options.getClientToken,
        options.clientTokenTtlMs ?? 60_000,
        options.refreshSkewMs ?? 30_000,
      ),
      browser: true,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
    }),
  );
}

function defaultWebSocketFactory(url: string) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new TypeError("A WebSocket implementation is required");
  }
  return new globalThis.WebSocket(url);
}

function parseWebSocketServerMessage(value: unknown): WebSocketServerMessage {
  if (typeof value !== "string") throw new TypeError("WebSocket message must be JSON text");
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed) || typeof parsed.type !== "string") {
    throw new TypeError("WebSocket message is invalid");
  }
  if (parsed.type === "event" && isAgentEvent(parsed.event)) {
    return { type: "event", event: parsed.event };
  }
  if (
    parsed.type === "replay.completed" &&
    Number.isSafeInteger(parsed.cursor) &&
    (parsed.cursor as number) >= 0 &&
    typeof parsed.hasMore === "boolean"
  ) {
    return {
      type: "replay.completed",
      cursor: parsed.cursor as number,
      hasMore: parsed.hasMore,
    };
  }
  if (
    parsed.type === "error" &&
    typeof parsed.code === "string" &&
    typeof parsed.message === "string"
  ) {
    return { type: "error", code: parsed.code, message: parsed.message };
  }
  throw new TypeError("WebSocket message is invalid");
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.id) &&
    (value.id as number) > 0 &&
    typeof value.sessionId === "string" &&
    Number.isSafeInteger(value.attempt) &&
    (value.attempt as number) >= 0 &&
    typeof value.type === "string" &&
    typeof value.createdAt === "string" &&
    (!("turnId" in value) || typeof value.turnId === "string")
  );
}

import type { ProviderModelPage, ProviderModelOptions, ProviderModelValidation } from "./types";
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
  ManagedSkillPackagePreview,
  ManagedSkillFile,
  ManagedSkillFileContent,
  ManagedSkillCatalogueEntry,
  InstallManagedSkillCatalogueInput,
  SkillCataloguePage,
  SkillCataloguePageOptions,
  BeginManagedMcpOAuthInput,
  BeginManagedMcpOAuthResult,
  CompleteManagedMcpOAuthInput,
  CompleteManagedMcpOAuthResult,
  ManagedMcpAppResource,
  ReadManagedMcpAppResourceInput,
  CallManagedMcpAppToolInput,
  VoiceCallConnection,
  VoiceCallConnectionOptions,
  VoiceCallServerMessage,
  VoiceCallState,
  VoiceMediaConfiguration,
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

  async connectVoiceCall(
    sessionId: string,
    options: VoiceCallConnectionOptions = {},
  ): Promise<VoiceCallConnection> {
    const issued = await this.request<{
      callId: string;
      sessionId: string;
      state: VoiceCallState;
      transport: "browser_pcm" | "sdk_bridge";
      media: VoiceMediaConfiguration;
      ticket: string;
      expiresAt: string;
      connectPath: string;
    }>(`/v1/sessions/${encodeURIComponent(sessionId)}/voice-calls`, {
      method: "POST",
      body: JSON.stringify({
        transport: options.transport ?? (this.options.browser ? "browser_pcm" : "sdk_bridge"),
        ...(options.clientCallId ? { clientCallId: options.clientCallId } : {}),
        ...(options.endpointing ? { endpointing: options.endpointing } : {}),
        ...(options.speechOutputFormat ? { speechOutputFormat: options.speechOutputFormat } : {}),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const runtimeOrigin = new URL(this.endpoint).origin;
    const socketUrl = new URL(issued.connectPath, runtimeOrigin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("ticket", issued.ticket);
    const createSocket = this.options.webSocket ?? defaultWebSocketFactory;
    const socket = createSocket(socketUrl.toString());
    let state = issued.state;
    let opened = false;
    let settled = false;

    return new Promise<VoiceCallConnection>((resolve, reject) => {
      const sendControl = (message: Record<string, unknown>) => {
        if (socket.readyState !== 1) {
          throw new AgentError("Voice media socket is not open", 0, "voice_socket_not_open");
        }
        socket.send(JSON.stringify(message));
      };
      const connection: VoiceCallConnection = {
        callId: issued.callId,
        sessionId: issued.sessionId,
        media: issued.media,
        get state() {
          return state;
        },
        sendAudio: (frame) => {
          if (socket.readyState !== 1) {
            throw new AgentError("Voice media socket is not open", 0, "voice_socket_not_open");
          }
          if (frame instanceof ArrayBuffer) socket.send(frame);
          else socket.send(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
        },
        sendText: (content, clientTurnId) => sendControl({
          type: "text",
          content,
          ...(clientTurnId ? { clientTurnId } : {}),
        }),
        endpoint: (utteranceId) => sendControl({
          type: "endpoint",
          ...(utteranceId ? { utteranceId } : {}),
        }),
        interrupt: () => sendControl({ type: "interrupt" }),
        end: (reason) => sendControl({ type: "end", ...(reason ? { reason } : {}) }),
        close: (code = 1000, reason = "client closed") => socket.close(code, reason),
      };
      const failBeforeOpen = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      socket.addEventListener("open", () => {
        opened = true;
        socket.send(JSON.stringify({ type: "ready" }));
        if (settled) return;
        settled = true;
        resolve(connection);
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          options.onAudio?.(event.data);
          return;
        }
        if (typeof Blob !== "undefined" && event.data instanceof Blob) {
          void event.data.arrayBuffer().then((audio) => options.onAudio?.(audio));
          return;
        }
        try {
          const message = parseVoiceCallServerMessage(event.data);
          if (message.type === "ready") options.onReady?.(message.media);
          if (message.type === "state") {
            state = message.state;
            options.onState?.(message.state, message.sequence);
          }
          if (message.type === "transcript") options.onTranscript?.(message);
          if (message.type === "turn") options.onTurn?.(message);
          if (message.type === "speech.start") options.onSpeechStart?.(message);
          if (message.type === "speech.end") options.onSpeechEnd?.(message);
          if (message.type === "error") {
            options.onError?.(new AgentError(message.message, 0, message.code));
          }
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          options.onError?.(normalized);
          socket.close(1008, "invalid voice message");
          if (!opened) failBeforeOpen(normalized);
        }
      });
      socket.addEventListener("error", () => {
        const error = new AgentError("Voice WebSocket connection failed", 0, "voice_websocket_failed");
        options.onError?.(error);
        if (!opened) failBeforeOpen(error);
      });
      socket.addEventListener("close", (event) => {
        options.onClose?.(event);
        if (!opened) failBeforeOpen(
          new AgentError("Voice WebSocket closed before connecting", 0, "voice_websocket_closed"),
        );
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

  connectVoice(options: VoiceCallConnectionOptions = {}): Promise<VoiceCallConnection> {
    return this.transport.connectVoiceCall(this.id, options);
  }

  readMcpAppResource(
    input: ReadManagedMcpAppResourceInput,
    options: RequestOptions = {},
  ): Promise<ManagedMcpAppResource> {
    return this.transport.request(
      `/v1/sessions/${encodeURIComponent(this.id)}/mcp-apps/resources/read`,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...requestInit(options),
      },
    );
  }

  callMcpAppTool(
    input: CallManagedMcpAppToolInput,
    options: RequestOptions = {},
  ): Promise<unknown> {
    return this.transport.request(
      `/v1/sessions/${encodeURIComponent(this.id)}/mcp-apps/tools/call`,
      {
        method: "POST",
        body: JSON.stringify({
          ...input,
          operationId: input.operationId ?? randomIdempotencyKey(),
          arguments: input.arguments ?? {},
        }),
        ...requestInit(options),
      },
    );
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
    create: async (
      agent: AgentDefinition,
      options: RequestOptions & { externalUserId?: string } = {},
    ): Promise<AgentSession> => {
      const created = await this.transport.request<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          agentRevisionId: agent.revisionId,
          ...(options.externalUserId === undefined ? {} : { externalUserId: options.externalUserId }),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return new AgentSession(this.transport, created.sessionId);
    },
    get: (sessionId: string): AgentSession => new AgentSession(this.transport, sessionId),
  };

  /** Requires provider_connections:read. Uses stored keys only on the server. */
  readonly providerModels = {
    list: (connectionId: string, options: ProviderModelOptions = {}): Promise<ProviderModelPage> => {
      const query = new URLSearchParams(pageQuery(options));
      if (options.query) query.set("q", options.query);
      if (options.refresh) query.set("refresh", "true");
      return this.transport.request(`/v1/provider-connections/${encodeURIComponent(connectionId)}/models?${query}`, requestInit(options));
    },
    validate: (connectionId: string, modelId: string, options: RequestOptions = {}): Promise<ProviderModelValidation> =>
      this.transport.request(`/v1/provider-connections/${encodeURIComponent(connectionId)}/models/validate`, {
        method: "POST", body: JSON.stringify({ modelId }), ...requestInit(options),
      }),
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
    beginOAuth: (
      serverId: string,
      input: BeginManagedMcpOAuthInput = {},
      options: RequestOptions = {},
    ): Promise<BeginManagedMcpOAuthResult> =>
      this.transport.request(`/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/begin`, {
        method: "POST",
        body: JSON.stringify(withOperationId({ scopes: [], ...input })),
        ...requestInit(options),
      }),
    completeOAuth: (
      input: CompleteManagedMcpOAuthInput,
      options: RequestOptions = {},
    ): Promise<CompleteManagedMcpOAuthResult> =>
      this.transport.request("/v1/mcp-oauth/complete", {
        method: "POST",
        body: JSON.stringify(input),
        ...requestInit(options),
      }),
    disconnectOAuth: (
      connectionId: string,
      options: RequestOptions = {},
    ): Promise<ManagedMcpAuthConnection> =>
      this.transport.request(`/v1/mcp-auth-connections/${encodeURIComponent(connectionId)}/oauth/disconnect`, {
        method: "POST",
        body: JSON.stringify({ operationId: randomIdempotencyKey() }),
        ...requestInit(options),
      }),
  };

  readonly skills = {
    list: (options: PageOptions = {}): Promise<Page<ManagedSkillSummary>> =>
      this.transport.request(`/v1/skills${pageQuery(options)}`, requestInit(options)),
    get: (skillId: string, options: RequestOptions = {}): Promise<ManagedSkill> =>
      this.transport.request(`/v1/skills/${encodeURIComponent(skillId)}`, requestInit(options)),
    validate: (input: CreateManagedSkillInput, options: RequestOptions = {}): Promise<ManagedSkillPackagePreview> =>
      this.transport.request("/v1/skills/validate", {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
        ...requestInit(options),
      }),
    listFiles: (skillId: string, options: RequestOptions = {}): Promise<ManagedSkillFile[]> =>
      this.transport.request(`/v1/skills/${encodeURIComponent(skillId)}/files`, requestInit(options)),
    readFile: (skillId: string, path: string, options: RequestOptions = {}): Promise<ManagedSkillFileContent> =>
      this.transport.request(`/v1/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(path)}`, requestInit(options)),
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

  readonly skillCatalogue = {
    list: (options: SkillCataloguePageOptions = {}): Promise<SkillCataloguePage> =>
      this.transport.request(`/v1/skill-catalogue${skillCatalogueQuery(options)}`, requestInit(options)),
    get: (catalogueId: string, options: RequestOptions = {}): Promise<ManagedSkillCatalogueEntry> =>
      this.transport.request(`/v1/skill-catalogue/${encodeURIComponent(catalogueId)}`, requestInit(options)),
    install: (catalogueId: string, input: InstallManagedSkillCatalogueInput = {}, options: RequestOptions = {}): Promise<ManagedSkill> =>
      this.transport.request(`/v1/skill-catalogue/${encodeURIComponent(catalogueId)}/install`, {
        method: "POST",
        body: JSON.stringify(withOperationId(input)),
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

function skillCatalogueQuery(options: SkillCataloguePageOptions): string {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.query?.trim()) query.set("q", options.query.trim());
  if (options.category?.trim()) query.set("category", options.category.trim());
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
      ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
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

function parseVoiceCallServerMessage(value: unknown): VoiceCallServerMessage {
  if (typeof value !== "string") throw new TypeError("Voice WebSocket message must be JSON text");
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed) || typeof parsed.type !== "string") {
    throw new TypeError("Voice WebSocket message is invalid");
  }
  if (
    parsed.type === "ready" &&
    typeof parsed.callId === "string" &&
    typeof parsed.sessionId === "string" &&
    isVoiceMediaConfiguration(parsed.media)
  ) return parsed as unknown as VoiceCallServerMessage;
  if (
    parsed.type === "state" &&
    isVoiceCallState(parsed.state) &&
    Number.isSafeInteger(parsed.sequence)
  ) return parsed as unknown as VoiceCallServerMessage;
  if (
    parsed.type === "transcript" &&
    typeof parsed.utteranceId === "string" &&
    typeof parsed.text === "string" &&
    typeof parsed.final === "boolean"
  ) return parsed as unknown as VoiceCallServerMessage;
  if (
    parsed.type === "turn" &&
    typeof parsed.turnId === "string" &&
    ["queued", "running", "completed", "failed", "cancelled"].includes(String(parsed.status))
  ) return parsed as unknown as VoiceCallServerMessage;
  if (
    parsed.type === "speech.start" &&
    typeof parsed.speechGenerationId === "string" &&
    Number.isSafeInteger(parsed.clauseIndex) &&
    typeof parsed.contentType === "string"
  ) return parsed as unknown as VoiceCallServerMessage;
  if (
    parsed.type === "speech.end" &&
    typeof parsed.speechGenerationId === "string" &&
    Number.isSafeInteger(parsed.clauseIndex) &&
    typeof parsed.interrupted === "boolean"
  ) return parsed as unknown as VoiceCallServerMessage;
  if (
    parsed.type === "error" &&
    typeof parsed.code === "string" &&
    typeof parsed.message === "string" &&
    typeof parsed.retryable === "boolean"
  ) return parsed as unknown as VoiceCallServerMessage;
  throw new TypeError("Voice WebSocket message is invalid");
}

function isVoiceMediaConfiguration(value: unknown): value is VoiceMediaConfiguration {
  return isObject(value) &&
    (value.encoding === "pcm_s16le" || value.encoding === "mulaw") &&
    [8_000, 16_000, 24_000].includes(Number(value.sampleRateHz)) &&
    value.channels === 1 &&
    [10, 20, 40].includes(Number(value.frameDurationMs));
}

function isVoiceCallState(value: unknown): value is VoiceCallState {
  return [
    "created", "connecting", "listening", "transcribing", "thinking",
    "speaking", "ended", "failed",
  ].includes(String(value));
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

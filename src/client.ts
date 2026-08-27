import type {
  AgentDefinition,
  BrowserAgentClientOptions,
  CreateSessionResponse,
  FetchLike,
  ListEventsResponse,
  RequestOptions,
  SessionSnapshot,
  SubmitOptions,
  SubmitTurnResponse,
  AgentClientOptions,
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

type TokenProvider = () => Promise<string>;

interface TransportOptions {
  endpoint: string;
  token: TokenProvider;
  fetch?: FetchLike;
}

class Transport {
  readonly endpoint: string;
  readonly fetchImplementation: FetchLike;

  constructor(private readonly options: TransportOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) throw new TypeError("A fetch implementation is required");
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${await this.options.token()}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.fetchImplementation(`${this.endpoint}${path}`, { ...init, headers });
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
}

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
      body: JSON.stringify({ content }),
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
}

/** Server entrypoint. Never pass this client or its API key into a browser bundle. */
export function createClient(options: AgentClientOptions): AgentClient {
  if (!options.apiKey.trim()) throw new TypeError("apiKey is required");
  return new AgentClient(
    new Transport({
      endpoint: options.endpoint,
      token: async () => options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  );
}

/** Browser-safe client used by the React subpath with short-lived client tokens. */
export function createBrowserClient(options: BrowserAgentClientOptions): AgentClient {
  return new AgentClient(
    new Transport({
      endpoint: options.endpoint,
      token: options.getClientToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  );
}

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
  ClientTokenResult,
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
      token: staticTokenProvider(options.apiKey),
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
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  );
}

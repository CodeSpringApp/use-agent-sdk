import {
  AgentEventBuffer,
  createAgent,
  createBrowserClient,
  type AgentEvent,
  type AgentWebSocket,
  type ClientTokenResult,
  type FetchLike,
} from "../src";

const apiKey = requiredEnvironmentVariable("USE_AGENT_API_KEY");
const endpoint = normalizeEndpoint(requiredEnvironmentVariable("USE_AGENT_ENDPOINT"));
const agentRevisionId = process.env.USE_AGENT_AGENT_REVISION_ID ?? "cs-onboarding-dev@1";
const [agentId, revision] = parseRevisionId(agentRevisionId);
const origin = new URL(endpoint).origin;
const clientToken = await issueClientToken();
const browserFetch: FetchLike = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Origin", origin);
  return fetch(input, { ...init, headers });
};
const client = createBrowserClient({
  endpoint: `${endpoint}/browser`,
  getClientToken: async () => clientToken,
  fetch: browserFetch,
  webSocket: (url) =>
    new (WebSocket as unknown as BunWebSocketConstructor)(url, {
      headers: { Origin: origin },
    }),
});
const session = await client.sessions.create(
  createAgent({ id: agentId, revision }),
);
const events = new AgentEventBuffer();
const initialReplay = deferred<void>();
const terminal = deferred<AgentEvent>();
const live = await session.connect({
  after: 0,
  onEvent: (event) => {
    const merged = events.merge([event]);
    if (merged.gap) {
      terminal.reject(
        new Error(
          `Live stream skipped event ${merged.gap.expected} before ${merged.gap.received}`,
        ),
      );
      return;
    }
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      terminal.resolve(event);
    }
  },
  onReplayComplete: () => initialReplay.resolve(),
  onError: (error) => {
    initialReplay.reject(error);
    terminal.reject(error);
  },
});

await withTimeout(initialReplay.promise, 30_000);
const submitted = await session.submit("Reply with a short onboarding greeting.");
const terminalEvent = await withTimeout(terminal.promise, 60_000);
live.close();
if (terminalEvent.turnId !== submitted.turnId) {
  throw new Error("Live terminal event belongs to a different turn");
}
if (terminalEvent.type !== "turn.completed") {
  throw new Error(`Turn ended with ${terminalEvent.type}`);
}

let replayCursor = 1;
let replayedEvents = 0;
const replayComplete = deferred<void>();
const replayConnection = await session.connect({
  after: replayCursor,
  onEvent: (event) => {
    if (event.id <= replayCursor) return;
    const expected = replayCursor + 1;
    if (event.id !== expected) {
      replayComplete.reject(
        new Error(`Replay expected event ${expected}, received ${event.id}`),
      );
      return;
    }
    replayCursor = event.id;
    replayedEvents += 1;
  },
  onReplayComplete: () => replayComplete.resolve(),
  onError: replayComplete.reject,
});
await withTimeout(replayComplete.promise, 30_000);
replayConnection.close();

console.log(
  JSON.stringify(
    {
      agentRevisionId,
      sessionId: session.id,
      turnId: submitted.turnId,
      liveCursor: events.cursor,
      replayedEvents,
      terminalEvent: terminalEvent.type,
    },
    null,
    2,
  ),
);

async function issueClientToken(): Promise<ClientTokenResult> {
  const response = await fetch(`${endpoint}/v1/client-tokens`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      externalUserId: `sdk-live-smoke-${crypto.randomUUID()}`,
      scopes: ["sessions:read", "sessions:write"],
      allowedAgentIds: [agentRevisionId],
      origin,
      expiresInSeconds: 300,
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw apiError(response.status, body);
  if (!isRecord(body) || typeof body.token !== "string") {
    throw new Error("Client-token response is invalid");
  }
  return {
    token: body.token,
    ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Live smoke test timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function apiError(status: number, body: unknown): Error {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : "request_failed";
    const message = typeof body.error.message === "string" ? body.error.message : "Request failed";
    return new Error(`${code} (${status}): ${message}`);
  }
  return new Error(`Request failed with ${status}`);
}

function parseRevisionId(value: string): [string, string] {
  const separator = value.lastIndexOf("@");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("USE_AGENT_AGENT_REVISION_ID must look like agent-id@revision");
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type BunWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => AgentWebSocket;

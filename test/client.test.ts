import { describe, expect, test } from "bun:test";
import {
  createAgent,
  createBrowserClient,
  createClient,
  type AgentWebSocket,
  type AgentWebSocketEventMap,
} from "../src";

describe("public SDK", () => {
  test("createAgent returns a stable revision reference", () => {
    const agent = createAgent({
      id: "support",
      revision: "7",
      model: "production-default",
      skills: [{ id: "returns" }],
    });
    expect(agent.revisionId).toBe("support@7");
    expect(agent.model).toBe("production-default");
    expect(Object.isFrozen(agent)).toBe(true);
  });

  test("virtual model profiles are reusable across agents", () => {
    const first = createAgent({ id: "triage", revision: "4", model: "production-default" });
    const second = createAgent({ id: "research", revision: "9", model: "production-default" });
    expect(first.model).toBe(second.model);
  });

  test("browser client caches and deduplicates client-token refreshes", async () => {
    let tokenLoads = 0;
    const client = createBrowserClient({
      endpoint: "http://localhost:8787",
      getClientToken: async () => {
        tokenLoads += 1;
        await Promise.resolve();
        return { token: "client-token", expiresAt: Date.now() + 300_000 };
      },
      fetch: async () => Response.json({
        sessionId: "session-1",
        agentRevisionId: "support@7",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cursor: 0,
        turns: [],
      }),
    });

    await Promise.all([client.sessions.get("session-1").get(), client.sessions.get("session-1").get()]);
    await client.sessions.get("session-1").get();
    expect(tokenLoads).toBe(1);
  });

  test("browser client invalidates and retries once after a 401", async () => {
    let tokenLoads = 0;
    let requests = 0;
    const client = createBrowserClient({
      endpoint: "http://localhost:8787",
      getClientToken: async () => ({
        token: `client-token-${++tokenLoads}`,
        expiresAt: Date.now() + 300_000,
      }),
      fetch: async () => {
        requests += 1;
        if (requests === 1) return Response.json({ error: { code: "invalid_token" } }, { status: 401 });
        return Response.json({
          sessionId: "session-1",
          agentRevisionId: "support@7",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cursor: 0,
          turns: [],
        });
      },
    });

    await client.sessions.get("session-1").get();
    expect(tokenLoads).toBe(2);
    expect(requests).toBe(2);
  });

  test("session creation authenticates and uses the agent revision", async () => {
    const requests: Request[] = [];
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(
          { sessionId: "00000000-0000-4000-8000-000000000001", agentRevisionId: "support@7", createdAt: new Date().toISOString() },
          { status: 201 },
        );
      },
    });

    const session = await client.sessions.create(createAgent({ id: "support", revision: "7" }));
    expect(session.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer ua_test_secret");
    expect(await requests[0]?.json()).toEqual({ agentRevisionId: "support@7" });
  });

  test("surfaces stable runtime error metadata", async () => {
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async () =>
        Response.json(
          { error: { code: "license_required", message: "Agents license required" } },
          { status: 403, headers: { "x-request-id": "req_123" } },
        ),
    });

    await expect(client.sessions.create(createAgent({ id: "support", revision: "7" }))).rejects.toEqual(
      expect.objectContaining({
        status: 403,
        code: "license_required",
        requestId: "req_123",
      }),
    );
  });

  test("submits opaque external asset references without storage URLs", async () => {
    const requests: Request[] = [];
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          sessionId: "session-1",
          turnId: "turn-1",
          status: "queued",
          cursor: 2,
          duplicate: false,
        }, { status: 202 });
      },
    });
    await client.sessions.get("session-1").submit("Inspect this", {
      attachments: [{
        kind: "external",
        assetId: "tenant-assets/reference-1",
        mediaType: "image/png",
        sizeBytes: 128,
      }],
    });
    expect(await requests[0]?.json()).toEqual({
      content: "Inspect this",
      attachments: [{
        kind: "external",
        assetId: "tenant-assets/reference-1",
        mediaType: "image/png",
        sizeBytes: 128,
      }],
    });
  });

  test("uses the supported paginated management routes and generates operation IDs", async () => {
    const requests: Request[] = [];
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          return Response.json({ items: [], cursor: null, hasMore: false });
        }
        return Response.json({
          toolId: "customer-echo",
          displayName: "Customer echo",
          status: "active",
          currentRevisionId: "customer-echo@1",
          currentRevision: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, { status: 201 });
      },
    });

    await client.agents.list({ limit: 25, cursor: "next-page" });
    await client.tools.create({
      toolId: "customer-echo",
      displayName: "Customer echo",
      initialRevision: {
        modelName: "customer_echo",
        description: "Echo input",
        inputSchema: { type: "object" },
        transport: {
          type: "customer_hosted",
          endpoint: "https://tools.example.com/api/agent-tools",
          handlerRevision: "2026-08-30.1",
        },
      },
    });

    expect(requests[0]?.url).toBe(
      "http://localhost:8787/v1/agents?limit=25&cursor=next-page",
    );
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe("http://localhost:8787/v1/tools");
    expect(await requests[1]?.json()).toMatchObject({
      toolId: "customer-echo",
      operationId: expect.any(String),
      initialRevision: {
        transport: { handlerRevision: "2026-08-30.1" },
      },
    });
  });

  test("manages MCP discovery and immutable skill revisions through namespaced clients", async () => {
    const requests: Request[] = [];
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          return Response.json({ items: [], cursor: null, hasMore: false });
        }
        return Response.json({ ok: true });
      },
    });

    await client.mcpServers.list({ limit: 25 });
    await client.mcpServers.create({
      serverId: "catalog",
      displayName: "Catalog",
      endpoint: "https://mcp.example.com/mcp",
    });
    await client.mcpServers.refresh("catalog");
    await client.skills.create({
      package: testSkillPackage("support-style", "Use concise answers."),
    });
    await client.skills.publish("support-style", {
      package: testSkillPackage("support-style", "Use concise, empathetic answers."),
      contextBudgetChars: 4096,
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/mcp-servers",
      "POST /v1/mcp-servers",
      "POST /v1/mcp-servers/catalog/refresh",
      "POST /v1/skills",
      "POST /v1/skills/support-style/publish",
    ]);
    expect(await requests[1]!.json()).toMatchObject({
      operationId: expect.any(String),
      serverId: "catalog",
      authMode: "none",
      authConnectionId: null,
    });
    expect(await requests[4]!.json()).toMatchObject({
      operationId: expect.any(String),
      contextBudgetChars: 4096,
    });
  });

  test("validates skill packages and accesses the curated catalogue", async () => {
    const requests: Request[] = [];
    const preview = {
      format: "agentskills.io/v1" as const,
      packageDigest: "a".repeat(64),
      packageBytes: 128,
      name: "support-style",
      displayName: "Support Style",
      description: "Keep support answers concise.",
      license: null,
      compatibility: null,
      metadata: {},
      allowedTools: null,
      files: [],
      diagnostics: [],
    };
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/v1/skills/validate") return Response.json(preview);
        if (path === "/v1/skills/support-style/files") return Response.json([]);
        if (path === "/v1/skills/support-style/file") {
          return Response.json({ file: null, text: "# Support style", contentBase64: null });
        }
        if (path === "/v1/skill-catalogue") return Response.json({ items: [], cursor: null, hasMore: false, total: 0, categories: [] });
        if (request.method === "GET") return Response.json({ catalogueId: "codespring/support-style" });
        return Response.json({ skillId: "support-style" });
      },
    });

    const validated = await client.skills.validate({ package: testSkillPackage("support-style", "Keep answers concise.") });
    expect(validated.files.length).toBe(0);
    await client.skills.listFiles("support-style");
    await client.skills.readFile("support-style", "references/policy.md");
    await client.skillCatalogue.list({ limit: 10, query: "support", category: "Customer support" });
    await client.skillCatalogue.get("codespring/support-style");
    await client.skillCatalogue.install("codespring/support-style");

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /v1/skills/validate",
      "GET /v1/skills/support-style/files",
      "GET /v1/skills/support-style/file",
      "GET /v1/skill-catalogue",
      "GET /v1/skill-catalogue/codespring%2Fsupport-style",
      "POST /v1/skill-catalogue/codespring%2Fsupport-style/install",
    ]);
    expect(new URL(requests[2]!.url).searchParams.get("path")).toBe("references/policy.md");
    expect(new URL(requests[3]!.url).searchParams.get("q")).toBe("support");
    expect(new URL(requests[3]!.url).searchParams.get("category")).toBe("Customer support");
    expect(await requests[5]!.json()).toMatchObject({ operationId: expect.any(String) });
  });

  test("creates authenticated MCP servers and revokes orphaned credentials on failure", async () => {
    const requests: Request[] = [];
    let failServer = false;
    const client = createClient({
      endpoint: "http://localhost:8787",
      apiKey: "ua_test_secret",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/v1/mcp-auth-connections" && request.method === "POST") {
          return Response.json({ connectionId: "00000000-0000-4000-8000-000000000901" });
        }
        if (path === "/v1/mcp-servers" && failServer) {
          return Response.json({ error: { code: "mcp_credential_rejected", message: "Rejected" } }, { status: 502 });
        }
        return Response.json({ serverId: "secure-catalog" });
      },
    });

    await client.mcpServers.createAuthenticated({
      serverId: "secure-catalog",
      displayName: "Secure catalog",
      endpoint: "https://mcp.example.com/mcp",
      authentication: { mode: "header", headerName: "X-API-Key", secret: "fake-secret" },
    });
    expect(await requests[0]!.json()).toMatchObject({
      mode: "header",
      headerName: "X-API-Key",
      secret: "fake-secret",
      operationId: expect.any(String),
    });
    expect(await requests[1]!.json()).toMatchObject({
      authMode: "header",
      authConnectionId: "00000000-0000-4000-8000-000000000901",
    });

    failServer = true;
    await expect(client.mcpServers.createAuthenticated({
      serverId: "rejected-catalog",
      displayName: "Rejected catalog",
      endpoint: "https://mcp.example.com/mcp",
      authentication: { mode: "bearer", secret: "rejected-secret" },
    })).rejects.toMatchObject({ code: "mcp_credential_rejected" });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`).slice(-3))
      .toEqual([
        "POST /v1/mcp-auth-connections",
        "POST /v1/mcp-servers",
        "POST /v1/mcp-auth-connections/00000000-0000-4000-8000-000000000901/revoke",
      ]);
  });

  test("exchanges a browser token for a cursor-bound WebSocket ticket", async () => {
    const requests: Request[] = [];
    let socket: FakeWebSocket | undefined;
    const received: number[] = [];
    const replayCursors: number[] = [];
    const client = createBrowserClient({
      endpoint: "http://localhost:8787/browser",
      getClientToken: async () => "client-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(
          { ticket: "opaque-ticket", expiresAt: new Date(Date.now() + 30_000).toISOString() },
          { status: 201 },
        );
      },
      webSocket: (url) => {
        socket = new FakeWebSocket(url);
        queueMicrotask(() => socket?.open());
        return socket;
      },
    });

    const connection = await client.sessions.get("session-1").connect({
      after: 4,
      onEvent: (event) => received.push(event.id),
      onReplayComplete: (cursor) => replayCursors.push(cursor),
    });

    expect(await requests[0]?.json()).toEqual({ after: 4 });
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer client-token");
    expect(socket?.url).toBe(
      "ws://localhost:8787/browser/v1/sessions/session-1/connect?ticket=opaque-ticket",
    );
    expect(socket?.url).not.toContain("client-token");

    socket?.message({
      type: "event",
      event: eventWithId(5),
    });
    socket?.message({ type: "replay.completed", cursor: 5, hasMore: true });
    expect(socket?.sent).toEqual([JSON.stringify({ type: "replay", after: 5 })]);
    socket?.message({
      type: "event",
      event: eventWithId(6),
    });
    socket?.message({ type: "replay.completed", cursor: 6, hasMore: false });

    expect(received).toEqual([5, 6]);
    expect(replayCursors).toEqual([6]);
    expect(connection.cursor).toBe(6);
  });
});

function eventWithId(id: number) {
  return {
    schemaVersion: 1,
    id,
    sessionId: "session-1",
    attempt: 1,
    type: "message.delta",
    createdAt: "2026-08-30T00:00:00.000Z",
    data: { delta: String(id) },
  };
}

function testSkillPackage(name: string, instructions: string) {
  const value = `---\nname: ${name}\ndescription: Test skill package for ${name}.\n---\n\n${instructions}\n`;
  return { files: [{ path: "SKILL.md", contentBase64: btoa(value), mediaType: "text/markdown" }] };
}

class FakeWebSocket implements AgentWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<keyof AgentWebSocketEventMap, Set<(event: Event) => void>>();

  constructor(readonly url: string) {}

  addEventListener<K extends keyof AgentWebSocketEventMap>(
    type: K,
    listener: (event: AgentWebSocketEventMap[K]) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener as (event: Event) => void);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  message(value: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  private emit<K extends keyof AgentWebSocketEventMap>(
    type: K,
    event: AgentWebSocketEventMap[K],
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

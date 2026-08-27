import { describe, expect, test } from "bun:test";
import { createAgent, createBrowserClient, createClient } from "../src";

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
});

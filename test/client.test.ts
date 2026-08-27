import { describe, expect, test } from "bun:test";
import { createAgent, createUseAgent } from "../src";

describe("public SDK", () => {
  test("createAgent returns a stable revision reference", () => {
    const agent = createAgent({ id: "support", revision: "7", skills: [{ id: "returns" }] });
    expect(agent.revisionId).toBe("support@7");
    expect(Object.isFrozen(agent)).toBe(true);
  });

  test("session creation authenticates and uses the agent revision", async () => {
    const requests: Request[] = [];
    const client = createUseAgent({
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
    const client = createUseAgent({
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

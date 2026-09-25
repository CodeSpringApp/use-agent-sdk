import { describe, expect, it } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import {
  CustomerToolError,
  createMemoryToolExecutionStore,
  createToolHandler,
  defineTool,
  executeToolLocally,
  type CustomerToolInvocation,
} from "../src";

const endpoint = "https://customer.example.com/api/agent-tools";
const issuer = "https://runtime.example.com";

describe("customer-hosted tools", () => {
  it("verifies an invocation, dispatches the pinned handler revision, and replays it", async () => {
    const signing = await signingFixture();
    let calls = 0;
    const lookup = defineTool<{ customerId: string }, { name: string }>({
      name: "lookup_customer",
      revision: "2026-08-30.1",
      description: "Look up a customer by ID.",
      inputSchema: {
        type: "object",
        properties: { customerId: { type: "string", minLength: 1, maxLength: 100 } },
        required: ["customerId"],
        additionalProperties: false,
      },
      async execute(input, context) {
        calls += 1;
        expect(context.tenantId).toBe("tenant_1");
        await Promise.resolve();
        return { name: input.customerId === "cus_123" ? "Ada" : "Unknown" };
      },
    });
    const handler = createToolHandler({
      endpoint,
      issuer,
      jwks: signing.jwks,
      executionStore: createMemoryToolExecutionStore(),
      tools: [lookup],
    });
    const invocation = fixtureInvocation();
    const request = await signedRequest(signing.privateKey, invocation);
    const [first, concurrent] = await Promise.all([
      handler(request),
      handler(await signedRequest(signing.privateKey, invocation)),
    ]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      operationId: invocation.operationId,
      output: { name: "Ada" },
    });
    expect(await concurrent.json()).toEqual({
      ok: true,
      operationId: invocation.operationId,
      output: { name: "Ada" },
    });
    const replay = await handler(await signedRequest(signing.privateKey, invocation));
    expect(replay.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("rechecks authorization before replaying a completed operation", async () => {
    const signing = await signingFixture();
    let allowed = true;
    let authorizations = 0;
    let executions = 0;
    const tool = defineTool<{ customerId: string }, string>({
      name: "lookup_customer",
      revision: "2026-08-30.1",
      description: "Look up a customer by ID.",
      inputSchema: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        additionalProperties: false,
      },
      execute() {
        executions += 1;
        return "Ada";
      },
    });
    const handler = createToolHandler({
      endpoint,
      issuer,
      jwks: signing.jwks,
      tools: [tool],
      executionStore: createMemoryToolExecutionStore(),
      authorize(context) {
        authorizations += 1;
        expect(context.sessionId).toBe("00000000-0000-4000-8000-000000000001");
        expect(context.externalUserId).toBe("customer-user-1");
        if (!allowed) throw new CustomerToolError("project_access_denied", "Project access is unavailable");
      },
    });
    const invocation = {
      ...fixtureInvocation(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      externalUserId: "customer-user-1",
    };

    const first = await handler(await signedRequest(signing.privateKey, invocation));
    expect(await first.json()).toMatchObject({ ok: true, output: "Ada" });
    allowed = false;
    const deniedReplay = await handler(await signedRequest(signing.privateKey, invocation));
    expect(deniedReplay.status).toBe(200);
    expect(await deniedReplay.json()).toEqual({
      ok: false,
      operationId: invocation.operationId,
      error: { code: "project_access_denied", message: "Project access is unavailable", retryable: false },
    });
    expect(authorizations).toBe(2);
    expect(executions).toBe(1);

    allowed = true;
    const permittedReplay = await handler(await signedRequest(signing.privateKey, invocation));
    expect(await permittedReplay.json()).toMatchObject({ ok: true, output: "Ada" });
    expect(authorizations).toBe(3);
    expect(executions).toBe(1);
  });

  it("denies a privileged tool to an HR role and rechecks a signed session on replay", async () => {
    const signing = await signingFixture();
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const roles = new Map([[sessionId, "hr" as "hr" | "superadmin"]]);
    let searches = 0;
    let promotions = 0;
    const noInput = {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false as const,
    };
    const search = defineTool({
      name: "search_candidates",
      revision: "1",
      description: "Search permitted applications.",
      inputSchema: noInput,
      execute() {
        searches += 1;
        return "permitted results";
      },
    });
    const promote = defineTool({
      name: "promote_user",
      revision: "1",
      description: "Promote a user to super admin.",
      inputSchema: noInput,
      execute() {
        promotions += 1;
        return "promoted";
      },
    });
    const handler = createToolHandler({
      endpoint, issuer, jwks: signing.jwks,
      tools: [search, promote],
      executionStore: createMemoryToolExecutionStore(),
      authorize(context) {
        const role = context.sessionId && roles.get(context.sessionId);
        if (!role || (context.toolId === "promote-user" && role !== "superadmin")) {
          throw new CustomerToolError("access_denied", "Access unavailable");
        }
      },
    });
    const base = {
      ...fixtureInvocation(),
      input: {},
    };
    const searchCall = {
      ...base,
      operationId: "tool:turn_1:0:1",
      toolId: "search-candidates",
      toolRevisionId: "search-candidates@1",
      toolName: "search_candidates",
      handlerRevision: "1",
    };
    const promotionCall = {
      ...base,
      operationId: "tool:turn_1:0:2",
      toolId: "promote-user",
      toolRevisionId: "promote-user@1",
      toolName: "promote_user",
      handlerRevision: "1",
    };
    const claims = { agent_session_id: sessionId, subject_id: "opaque-actor" };

    expect(await (await handler(await signedRequest(signing.privateKey, searchCall, searchCall, claims))).json())
      .toMatchObject({ ok: true, output: "permitted results" });
    expect(await (await handler(await signedRequest(signing.privateKey, promotionCall, promotionCall, claims))).json())
      .toMatchObject({ ok: false, error: { code: "access_denied" } });
    expect(searches).toBe(1);
    expect(promotions).toBe(0);

    roles.set(sessionId, "superadmin");
    expect(await (await handler(await signedRequest(signing.privateKey, promotionCall, promotionCall, claims))).json())
      .toMatchObject({ ok: true, output: "promoted" });
    expect(promotions).toBe(1);

    roles.set(sessionId, "hr");
    expect(await (await handler(await signedRequest(signing.privateKey, promotionCall, promotionCall, claims))).json())
      .toMatchObject({ ok: false, error: { code: "access_denied" } });
    expect(promotions).toBe(1);
  });

  it("requires the pinned endpoint and protocol envelope", async () => {
    const signing = await signingFixture();
    const handler = createToolHandler({
      endpoint,
      issuer,
      jwks: signing.jwks,
      executionStore: createMemoryToolExecutionStore(),
      tools: [],
    });
    const invocation = fixtureInvocation();
    const queryRequest = await signedRequest(signing.privateKey, invocation);
    const withQuery = new Request(`${endpoint}?unexpected=1`, queryRequest);
    expect((await handler(withQuery)).status).toBe(404);

    const missingVersion = await signedRequest(signing.privateKey, invocation);
    missingVersion.headers.delete("CodeSpring-Agent-Tool-Version");
    expect((await handler(missingVersion)).status).toBe(400);
  });

  it("rejects a body changed after signing", async () => {
    const signing = await signingFixture();
    const handler = createToolHandler({
      endpoint,
      issuer,
      jwks: signing.jwks,
      executionStore: createMemoryToolExecutionStore(),
      tools: [],
    });
    const invocation = fixtureInvocation();
    const request = await signedRequest(signing.privateKey, invocation, {
      ...invocation,
      input: { customerId: "cus_tampered" },
    });
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_tool_authorization",
        message: "Tool authorization is invalid",
      },
    });
  });

  it("passes only verified session and end-user identity to the tool", async () => {
    const signing = await signingFixture();
    let executed = false;
    const tool = defineTool<{ customerId: string }, string>({
      name: "lookup_customer",
      revision: "2026-08-30.1",
      description: "Look up a customer by ID.",
      inputSchema: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        additionalProperties: false,
      },
      execute(_input, context) {
        executed = true;
        expect(context.sessionId).toBe("00000000-0000-4000-8000-000000000001");
        expect(context.externalUserId).toBe("customer-user-1");
        return "ok";
      },
    });
    const handler = createToolHandler({
      endpoint, issuer, jwks: signing.jwks,
      executionStore: createMemoryToolExecutionStore(), tools: [tool],
    });
    const invocation = {
      ...fixtureInvocation(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      externalUserId: "customer-user-1",
    };
    const wrongClaim = await handler(await signedRequest(
      signing.privateKey, invocation, invocation,
      { external_user_id: "customer-user-2" },
    ));
    expect(wrongClaim.status).toBe(401);
    const incompleteInvocation: CustomerToolInvocation = { ...invocation };
    delete incompleteInvocation.externalUserId;
    const incompleteBody = await handler(await signedRequest(
      signing.privateKey, invocation, incompleteInvocation,
    ));
    expect(incompleteBody.status).toBe(400);
    expect(executed).toBe(false);
    const accepted = await handler(await signedRequest(signing.privateKey, invocation));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, output: "ok" });
    expect(executed).toBe(true);
  });

  it("exposes generic signed session and subject claims without legacy body identity", async () => {
    const signing = await signingFixture();
    let received: { sessionId: string | undefined; subjectId: string | undefined; externalUserId: string | undefined } | undefined;
    const tool = defineTool<{ customerId: string }, string>({
      name: "lookup_customer",
      revision: "2026-08-30.1",
      description: "Look up a customer by ID.",
      inputSchema: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        additionalProperties: false,
      },
      execute(_input, context) {
        received = {
          sessionId: context.sessionId,
          subjectId: context.subjectId,
          externalUserId: context.externalUserId,
        };
        return "ok";
      },
    });
    const handler = createToolHandler({
      endpoint, issuer, jwks: signing.jwks,
      executionStore: createMemoryToolExecutionStore(), tools: [tool],
    });
    const invocation = fixtureInvocation();
    const claims = {
      agent_session_id: "00000000-0000-4000-8000-000000000001",
      subject_id: "opaque-user-1",
    };
    const accepted = await handler(await signedRequest(signing.privateKey, invocation, invocation, claims));
    expect(accepted.status).toBe(200);
    expect(received).toEqual({
      sessionId: claims.agent_session_id,
      subjectId: claims.subject_id,
      externalUserId: undefined,
    });

    const wrongClaim = await handler(await signedRequest(signing.privateKey, {
      ...invocation,
      operationId: "tool:turn_1:0:1",
      sessionId: "00000000-0000-4000-8000-000000000001",
      externalUserId: "customer-user-1",
    }, undefined, {
      agent_session_id: "00000000-0000-4000-8000-000000000002",
    }));
    expect(wrongClaim.status).toBe(401);

    const malformedClaim = await handler(await signedRequest(signing.privateKey, {
      ...invocation, operationId: "tool:turn_1:0:2",
    }, undefined, { agent_session_id: "not-a-session" }));
    expect(malformedClaim.status).toBe(401);

    const orphanedSubject = await handler(await signedRequest(signing.privateKey, {
      ...invocation, operationId: "tool:turn_1:0:3",
    }, undefined, { subject_id: "opaque-user-1" }));
    expect(orphanedSubject.status).toBe(401);
  });

  it("supports local execution without an HTTP round trip", async () => {
    let localIdentity: { sessionId: string | undefined; subjectId: string | undefined; externalUserId: string | undefined } | undefined;
    const add = defineTool<{ left: number; right: number }, number>({
      name: "add",
      revision: "1",
      description: "Add two integers.",
      inputSchema: {
        type: "object",
        properties: {
          left: { type: "integer" },
          right: { type: "integer" },
        },
        required: ["left", "right"],
        additionalProperties: false,
      },
      execute(input, context) {
        localIdentity = {
          sessionId: context.sessionId,
          subjectId: context.subjectId,
          externalUserId: context.externalUserId,
        };
        return input.left + input.right;
      },
    });

    await expect(executeToolLocally(add, { left: 2, right: 3 }, {
      sessionId: "00000000-0000-4000-8000-000000000001",
      subjectId: "opaque-user-1",
      externalUserId: "customer-user-1",
    })).resolves.toBe(5);
    expect(localIdentity).toEqual({
      sessionId: "00000000-0000-4000-8000-000000000001",
      subjectId: "opaque-user-1",
      externalUserId: "customer-user-1",
    });
    await expect(executeToolLocally(add, { left: 2.5, right: 3 })).rejects.toMatchObject({
      code: "invalid_tool_arguments",
    });
  });
});

function fixtureInvocation(): CustomerToolInvocation {
  return {
    schemaVersion: 1,
    operationId: "tool:turn_1:0:0",
    tenantId: "tenant_1",
    environmentId: "production",
    agentRevisionId: "support@7",
    toolId: "customer-lookup",
    toolRevisionId: "customer-lookup@3",
    toolName: "lookup_customer",
    handlerRevision: "2026-08-30.1",
    input: { customerId: "cus_123" },
  };
}

async function signingFixture() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwks: {
      keys: [{ ...publicJwk, kid: "test-v1", alg: "ES256", use: "sig" }],
    },
  };
}

async function signedRequest(
  privateKey: CryptoKey,
  signedInvocation: CustomerToolInvocation,
  requestInvocation: CustomerToolInvocation = signedInvocation,
  claimOverrides: Record<string, unknown> = {},
): Promise<Request> {
  const signedBody = JSON.stringify(signedInvocation);
  const requestBody = JSON.stringify(requestInvocation);
  const token = await new SignJWT({
    body_sha256: await sha256Base64Url(signedBody),
    operation_id: signedInvocation.operationId,
    tenant_id: signedInvocation.tenantId,
    environment_id: signedInvocation.environmentId,
    agent_revision_id: signedInvocation.agentRevisionId,
    tool_id: signedInvocation.toolId,
    tool_revision_id: signedInvocation.toolRevisionId,
    tool_name: signedInvocation.toolName,
    handler_revision: signedInvocation.handlerRevision,
    ...(signedInvocation.sessionId === undefined ? {} : {
      session_id: signedInvocation.sessionId,
      external_user_id: signedInvocation.externalUserId,
    }),
    ...claimOverrides,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-v1", typ: "codespring-agent-tool+jwt" })
    .setIssuer(issuer)
    .setAudience(endpoint)
    .setSubject(`${signedInvocation.tenantId}:${signedInvocation.environmentId}`)
    .setJti(signedInvocation.operationId)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(privateKey);
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CodeSpring-Agent-Tool-JWT": token,
      "CodeSpring-Agent-Tool-Version": "1",
    },
    body: requestBody,
  });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Buffer.from(digest).toString("base64url");
}

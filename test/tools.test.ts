import { describe, expect, it } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import {
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

  it("supports local execution without an HTTP round trip", async () => {
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
      execute(input) {
        return input.left + input.right;
      },
    });

    await expect(executeToolLocally(add, { left: 2, right: 3 })).resolves.toBe(5);
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

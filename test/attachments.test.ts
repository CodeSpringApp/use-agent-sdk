import { describe, expect, it } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import {
  createAttachmentResolverHandler,
  createPresignedAttachmentAdapter,
  type ExternalAssetRef,
} from "../src";

const endpoint = "https://customer.example.com/api/agent-assets";
const issuer = "https://runtime.example.com";
const bytes = new TextEncoder().encode("image-bytes");
const asset: ExternalAssetRef = {
  kind: "external",
  assetId: "tenant-assets/asset-1",
  mediaType: "image/png",
  sizeBytes: bytes.byteLength,
};

describe("customer-owned attachments", () => {
  it("uploads directly to a customer presigned target", async () => {
    const requests: Request[] = [];
    const adapter = createPresignedAttachmentAdapter({
      async prepareUpload(file) {
        expect(file.name).toBe("reference.png");
        return { asset, upload: { url: "https://storage.customer.example/assets/asset-1" } };
      },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 200 });
      },
      maximumTotalBytes: bytes.byteLength,
    });
    const file = new File([bytes], "reference.png", { type: "image/png" });
    await expect(adapter.upload(file, { signal: new AbortController().signal })).resolves.toEqual(asset);
    expect(requests[0]?.url).toBe("https://storage.customer.example/assets/asset-1");
    expect(requests[0]?.headers.get("Content-Type")).toBe("image/png");
    expect(adapter.maximumTotalBytes).toBe(bytes.byteLength);
  });

  it("verifies the signed runtime resolver request and returns bounded bytes", async () => {
    const signing = await signingFixture();
    const handler = createAttachmentResolverHandler({
      endpoint,
      handlerRevision: "assets-2026-09-01",
      issuer,
      jwks: signing.jwks,
      async resolve(context) {
        expect(context.asset).toEqual(asset);
        return bytes;
      },
    });
    const invocation = {
      schemaVersion: 1 as const,
      operationId: "asset:turn-1:ref-1",
      tenantId: "tenant_1",
      environmentId: "production",
      agentRevisionId: "support@7",
      handlerRevision: "assets-2026-09-01",
      asset,
    };
    const response = await handler(await signedRequest(signing.privateKey, invocation));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a tampered asset reference", async () => {
    const signing = await signingFixture();
    const handler = createAttachmentResolverHandler({
      endpoint,
      handlerRevision: "assets-2026-09-01",
      issuer,
      jwks: signing.jwks,
      resolve: async () => bytes,
    });
    const signed = {
      schemaVersion: 1 as const,
      operationId: "asset:turn-1:ref-1",
      tenantId: "tenant_1",
      environmentId: "production",
      agentRevisionId: "support@7",
      handlerRevision: "assets-2026-09-01",
      asset,
    };
    const request = await signedRequest(signing.privateKey, signed, {
      ...signed,
      asset: { ...asset, assetId: "tenant-assets/other" },
    });
    expect((await handler(request)).status).toBe(401);
  });

  it("binds the authorization token to the exact opaque asset ID", async () => {
    const signing = await signingFixture();
    const handler = createAttachmentResolverHandler({
      endpoint,
      handlerRevision: "assets-2026-09-01",
      issuer,
      jwks: signing.jwks,
      resolve: async () => bytes,
    });
    const invocation = {
      schemaVersion: 1 as const,
      operationId: "asset:turn-1:ref-1",
      tenantId: "tenant_1",
      environmentId: "production",
      agentRevisionId: "support@7",
      handlerRevision: "assets-2026-09-01",
      asset,
    };
    const request = await signedRequest(signing.privateKey, invocation, invocation, "tenant-assets/other");
    expect((await handler(request)).status).toBe(401);
  });
});

async function signingFixture() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [{ ...publicJwk, kid: "test-v1", alg: "ES256", use: "sig" }] },
  };
}

async function signedRequest(
  privateKey: CryptoKey,
  signedInvocation: Record<string, unknown>,
  requestInvocation: Record<string, unknown> = signedInvocation,
  assetIdClaim?: string,
): Promise<Request> {
  const signedBody = JSON.stringify(signedInvocation);
  const invocation = signedInvocation as {
    operationId: string;
    tenantId: string;
    environmentId: string;
    agentRevisionId: string;
    handlerRevision: string;
    asset: { assetId: string };
  };
  const token = await new SignJWT({
    body_sha256: await sha256Base64Url(signedBody),
    operation_id: invocation.operationId,
    tenant_id: invocation.tenantId,
    environment_id: invocation.environmentId,
    agent_revision_id: invocation.agentRevisionId,
    handler_revision: invocation.handlerRevision,
    asset_id: assetIdClaim ?? invocation.asset.assetId,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-v1", typ: "codespring-agent-asset+jwt" })
    .setIssuer(issuer)
    .setAudience(endpoint)
    .setSubject(`${invocation.tenantId}:${invocation.environmentId}`)
    .setJti(invocation.operationId)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(privateKey);
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CodeSpring-Agent-Asset-JWT": token,
      "CodeSpring-Agent-Asset-Version": "1",
    },
    body: JSON.stringify(requestInvocation),
  });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Buffer.from(digest).toString("base64url");
}

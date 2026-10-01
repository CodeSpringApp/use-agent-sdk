import { describe, expect, it } from "bun:test";
import { createPartnerClient, PartnerApiError } from "../src/partner";

const key = `ua_partner_${"a".repeat(32)}_${"b".repeat(43)}`;

describe("partner SDK", () => {
  it("sends the account-bound key and idempotency key only to the partner API", async () => {
    let request: Request | undefined;
    const client = createPartnerClient({ apiKey: key, endpoint: "https://api.example.test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ workspaceId: "workspace_1" });
      } });
    await client.workspaces.create({ externalCustomerId: "merchant-1", displayName: "Merchant",
      idempotencyKey: "create-merchant-1" });
    expect(request?.url).toBe("https://api.example.test/v1/partner/workspaces");
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${key}`);
    expect(request?.headers.get("Idempotency-Key")).toBe("create-merchant-1");
    expect(await request?.json()).toEqual({ externalCustomerId: "merchant-1", displayName: "Merchant" });
  });

  it("surfaces typed partner errors without exposing the key", async () => {
    const client = createPartnerClient({ apiKey: key, fetch: async () =>
      Response.json({ error: { code: "workspace_capacity_reached", message: "Capacity reached" } }, { status: 409 }) });
    try { await client.workspaces.list(); }
    catch (error) {
      expect(error).toBeInstanceOf(PartnerApiError);
      expect(error).toMatchObject({ status: 409, code: "workspace_capacity_reached" });
      expect(String(error)).not.toContain(key);
      return;
    }
    throw new Error("Expected a partner API error");
  });

  it("sends a cross-workspace clone with explicit source and destination bindings", async () => {
    let request: Request | undefined;
    const client = createPartnerClient({ apiKey: key, endpoint: "https://api.example.test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ agent: { agentId: "copy", currentRevisionId: null }, sourceRevisionId: "source@1" });
      } });
    await client.agents.clone("destination", "source", {
      operationId: "00000000-0000-4000-8000-000000000001", environmentId: "development",
      sourceWorkspaceId: "source-workspace", sourceEnvironmentId: "development",
      sourceRevisionId: "source@1", agentId: "copy", displayName: "Copy",
      modelProfileId: "destination-model",
    });
    expect(request?.url).toBe("https://api.example.test/v1/partner/workspaces/destination/agents/source/clone");
    expect(await request?.json()).toMatchObject({ sourceWorkspaceId: "source-workspace",
      sourceRevisionId: "source@1", modelProfileId: "destination-model" });
  });
});

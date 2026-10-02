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

  it("updates limits with a version and reads the member balance", async () => {
    const requests: Request[] = [];
    const client = createPartnerClient({ apiKey: key, endpoint: "https://api.example.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ workspaceId: "merchant", version: 2 });
      } });
    await client.limits.update("merchant", { expectedVersion: 1, maxDailyTurns: 12,
      defaultMemberMaxDailyTurns: 2 });
    await client.limits.memberBalance("merchant", "member/7");
    expect(requests[0]?.method).toBe("PUT");
    expect(await requests[0]?.json()).toEqual({ expectedVersion: 1, maxDailyTurns: 12,
      defaultMemberMaxDailyTurns: 2 });
    expect(requests[1]?.url).toBe("https://api.example.test/v1/partner/workspaces/merchant/members/member%2F7/limits/balance");
  });

  it("publishes a pinned template and installs it with an explicit destination model", async () => {
    const requests: Request[] = [];
    const client = createPartnerClient({ apiKey: key, endpoint: "https://api.example.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ templateId: "research-helper", version: 1 });
      } });
    await client.templates.publish({ operationId: "00000000-0000-4000-8000-000000000001",
      templateId: "research-helper", expectedVersion: 0, title: "Research helper",
      summary: "Answers questions", category: "research", icon: "search",
      sourceWorkspaceId: "source", sourceEnvironmentId: "development",
      sourceAgentId: "research", sourceRevisionId: "research@1",
      reviewedPortableContent: true });
    await client.templates.install("merchant", "research-helper", {
      operationId: "00000000-0000-4000-8000-000000000002", version: 1,
      environmentId: "development", agentId: "research-copy", displayName: "Research copy",
      modelProfileId: "merchant-model",
    });
    expect(requests[0]?.url).toBe("https://api.example.test/v1/partner/templates");
    expect(await requests[0]?.json()).toMatchObject({ sourceRevisionId: "research@1",
      reviewedPortableContent: true });
    expect(requests[1]?.url).toBe("https://api.example.test/v1/partner/workspaces/merchant/templates/research-helper/install");
    expect(await requests[1]?.json()).toMatchObject({ version: 1, modelProfileId: "merchant-model" });
  });

  it("lists account subjects and changes status with a version check", async () => {
    const requests: Request[] = [];
    const client = createPartnerClient({ apiKey: key, endpoint: "https://api.example.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ partnerSubjectId: "ps_123", version: 2 });
      } });
    await client.subjects.list({ externalUserId: "user/7", limit: 20 });
    await client.subjects.get("ps_123");
    await client.subjects.suspend("ps_123", 1);
    await client.subjects.resume("ps_123", 2);
    await client.provisioning.get();
    await client.provisioning.getWorkspace("wsp_123");
    await client.subjects.erase("ps_123", {
      expectedVersion: 3, operationId: "00000000-0000-4000-8000-000000000001",
    });
    await client.subjects.erasureStatus("ps_123");
    expect(requests.map(item => item.url)).toEqual([
      "https://api.example.test/v1/partner/subjects?externalUserId=user%2F7&limit=20",
      "https://api.example.test/v1/partner/subjects/ps_123",
      "https://api.example.test/v1/partner/subjects/ps_123/suspend",
      "https://api.example.test/v1/partner/subjects/ps_123/resume",
      "https://api.example.test/v1/partner/provisioning",
      "https://api.example.test/v1/partner/workspaces/wsp_123/provisioning",
      "https://api.example.test/v1/partner/subjects/ps_123/erase",
      "https://api.example.test/v1/partner/subjects/ps_123/erasure",
    ]);
    expect(await requests[2]?.json()).toEqual({ expectedVersion: 1 });
    expect(await requests[3]?.json()).toEqual({ expectedVersion: 2 });
    expect(await requests[6]?.json()).toEqual({ expectedVersion: 3,
      operationId: "00000000-0000-4000-8000-000000000001" });
  });
});

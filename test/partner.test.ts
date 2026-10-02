import { describe, expect, it } from "bun:test";
import { createPartnerClient, completePartnerDataErasure, PartnerApiError } from "../src/partner";

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
    await client.subjects.erasureManifest("ps_123",{cursor:"opaque",limit:50});
    await client.subjects.acknowledgePartnerCleanup("ps_123",{
      operationId:"00000000-0000-4000-8000-000000000001",
      memory:"completed",integrations:"not_applicable",
    });
    expect(requests.map(item => item.url)).toEqual([
      "https://api.example.test/v1/partner/subjects?externalUserId=user%2F7&limit=20",
      "https://api.example.test/v1/partner/subjects/ps_123",
      "https://api.example.test/v1/partner/subjects/ps_123/suspend",
      "https://api.example.test/v1/partner/subjects/ps_123/resume",
      "https://api.example.test/v1/partner/provisioning",
      "https://api.example.test/v1/partner/workspaces/wsp_123/provisioning",
      "https://api.example.test/v1/partner/subjects/ps_123/erase",
      "https://api.example.test/v1/partner/subjects/ps_123/erasure",
      "https://api.example.test/v1/partner/subjects/ps_123/erasure/manifest?cursor=opaque&limit=50",
      "https://api.example.test/v1/partner/subjects/ps_123/erasure/partner-cleanup",
    ]);
    expect(await requests[2]?.json()).toEqual({ expectedVersion: 1 });
    expect(await requests[3]?.json()).toEqual({ expectedVersion: 2 });
    expect(await requests[6]?.json()).toEqual({ expectedVersion: 3,
      operationId: "00000000-0000-4000-8000-000000000001" });
    expect(await requests[9]?.json()).toEqual({
      operationId:"00000000-0000-4000-8000-000000000001",
      memory:"completed",integrations:"not_applicable",
    });
  });

  it("sends bounded provisioning controls, batch items, and explicit JIT intent", async () => {
    const requests:Request[] = [];
    const client = createPartnerClient({apiKey:key,endpoint:"https://api.example.test",
      fetch:async (input,init) => {
        requests.push(new Request(input,init));
        return Response.json({results:[],succeeded:0,failed:0});
      }});
    await client.provisioning.update({expectedVersion:1,maxSubjects:100,
      maxMembersPerWorkspace:25,maxNewSubjectsPerDay:10,maxNewMembersPerDay:50});
    await client.provisioning.updateWorkspace("workspace/1",{
      expectedVersion:1,maxMembers:10,autoProvisionEndUsers:true});
    await client.members.upsertBatch("workspace/1",[
      {operationId:"00000000-0000-4000-8000-000000000001",
        externalUserId:"user/1",role:"end_user"},
    ]);
    await client.runtime.createClientToken("workspace/1",{
      externalUserId:"user/1",environmentId:"development",
      allowedAgentIds:["agent@1"],origin:"https://example.com",
      provisionIfMissing:true,
    });
    expect(requests.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "PUT /v1/partner/provisioning",
      "PUT /v1/partner/workspaces/workspace%2F1/provisioning",
      "POST /v1/partner/workspaces/workspace%2F1/members/batch",
      "POST /v1/partner/workspaces/workspace%2F1/client-tokens",
    ]);
    expect(await requests[2]?.json()).toEqual({items:[{operationId:
      "00000000-0000-4000-8000-000000000001",externalUserId:"user/1",role:"end_user"}]});
    expect(await requests[3]?.json()).toMatchObject({provisionIfMissing:true});
  });

  it("acknowledges partner cleanup only after both idempotent callbacks finish",async () => {
    const paths:string[] = [];
    const client = createPartnerClient({apiKey:key,endpoint:"https://api.example.test",
      fetch:async (input,init) => {
        const request = new Request(input,init);
        paths.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
        if (request.method === "POST") return Response.json({status:"completed",
          partnerCleanup:{memory:"completed",integrations:"completed"}});
        const cursor = new URL(request.url).searchParams.get("cursor");
        return Response.json({operationId:"00000000-0000-4000-8000-000000000001",
          partnerSubjectId:"ps_1",items:[{accountId:"acc_1",workspaceId:"w_1",
            subjectId:cursor ? "sub_2" : "sub_1"}],cursor:cursor ? null : "page-2"});
      }});
    const observed:string[] = [];
    const result = await completePartnerDataErasure(client,"ps_1",{
      memory:async ({namespaces}) => {for await (const item of namespaces)
        observed.push(`memory:${item.subjectId}`);},
      integrations:async ({namespaces}) => {for await (const item of namespaces)
        observed.push(`integrations:${item.subjectId}`);},
    });
    expect(observed).toEqual(["memory:sub_1","memory:sub_2",
      "integrations:sub_1","integrations:sub_2"]);
    expect(paths.at(-1)).toBe("POST /v1/partner/subjects/ps_1/erasure/partner-cleanup");
    expect(result.partnerCleanup).toMatchObject({memory:"completed",integrations:"completed"});
  });

  it("leaves partner cleanup unacknowledged when deletion fails",async () => {
    let acknowledgments = 0;
    const client = createPartnerClient({apiKey:key,fetch:async (input,init) => {
      const request = new Request(input,init);
      if (request.method === "POST") acknowledgments += 1;
      return Response.json({operationId:"00000000-0000-4000-8000-000000000001",
        partnerSubjectId:"ps_1",items:[],cursor:null});
    }});
    await expect(completePartnerDataErasure(client,"ps_1",{
      memory:async () => {throw new Error("store unavailable");},
      integrations:"not_applicable",
    })).rejects.toThrow("store unavailable");
    expect(acknowledgments).toBe(0);
  });
});

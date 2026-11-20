import { expect, test } from "bun:test";
import { createAgent, createClient } from "../src";
const grantId = "00000000-0000-4000-8000-000000000123";
test("personal plan methods preserve metadata and pin inference at session creation", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = createClient({ endpoint: "https://runtime.test", apiKey: "personal-cli-token", fetch: async (raw, init) => {
    const request = new Request(raw, init); const path = new URL(request.url).pathname; const body = request.method === "POST" ? await request.json() : null; calls.push({ path, body });
    if (path === "/v1/chatgpt-plan/status") return Response.json({ eligible: true, status: "connected", grantId, account: { label: "Account" }, manageUsageUrl: "https://chatgpt.com/settings/usage" });
    if (path === "/v1/chatgpt-plan/models") return Response.json({ models: [{ id: "model-v1", label: "Model" }] });
    if (path === "/v1/chatgpt-plan/begin") return Response.json({ authorizationUrl: "https://auth.openai.com/authorize", expiresAt: new Date().toISOString() });
    if (path === "/v1/sessions") return Response.json({ sessionId: "test-session", agentRevisionId: "writer@1", createdAt: new Date().toISOString() });
    return Response.json({ eligible: true, status: "disconnected", grantId: null, account: null, manageUsageUrl: "https://chatgpt.com/settings/usage" });
  } });
  expect((await client.chatGPTPlan.status()).grantId).toBe(grantId);
  expect((await client.chatGPTPlan.models()).models[0]?.id).toBe("model-v1");
  await client.chatGPTPlan.authorize();
  const inference = { source: "chatgpt_plan", model: "model-v1", grantId } as const;
  await client.sessions.create(createAgent({ id: "writer", revision: "1" }), { executionHarness: "codex_wasm_v1", inference });
  expect(calls.at(-1)?.body).toEqual({ agentRevisionId: "writer@1", executionHarness: "codex_wasm_v1", inference });
  await client.chatGPTPlan.disconnect();
  expect(calls.at(-1)).toEqual({ path: "/v1/chatgpt-plan/disconnect", body: {} });
});
test("plan errors are returned without retrying against another inference source", async () => {
  let calls = 0;
  const client = createClient({ endpoint: "https://runtime.test", apiKey: "personal-cli-token", fetch: async () => { calls++; return Response.json({ error: { code: "chatgpt_plan_setup_required", message: "Setup pending" } }, { status: 503 }); } });
  await expect(client.chatGPTPlan.authorize()).rejects.toMatchObject({ code: "chatgpt_plan_setup_required" });
  expect(calls).toBe(1);
});

test("agent writes use current MCP selections and reject ambiguous legacy selections", async () => {
  const bodies: any[] = [];
  const client = createClient({ endpoint: "https://runtime.test", apiKey: "test", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return Response.json({ agentId: "test" });
  } });
  const draft = { displayName: "Test", instructions: "Test", modelProfileId: "model", toolIds: [], maxModelSteps: 4, maxToolCalls: 2 };
  await client.agents.create({ ...draft, agentId: "test", mcpToolIds: [] });
  expect(bodies[0]).not.toHaveProperty("mcpToolIds"); expect(bodies[0].agentId).toBe("test");
  const mcpServers = [{ serverId: "server", snapshotId: "snapshot", enabledToolNames: ["lookup"] }];
  await client.agents.updateDraft("test", { ...draft, mcpServers });
  expect(bodies[1].mcpServers).toEqual(mcpServers);
  expect(() => client.agents.create({ ...draft, agentId: "test", mcpToolIds: ["legacy"] })).toThrow("Use mcpServers");
  expect(bodies).toHaveLength(2);
});

test("CLI plan mutations require explicit intent and a personal login", async () => {
  const { runCli } = await import("../src/cli");
  let output = ""; let requests = 0;
  const dependencies = { stdout: { write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { output += text; } }, env: { CODESPRING_AGENTS_API_KEY: "workspace-key" }, fetch: (async () => { requests++; throw new Error("No network request expected"); }) as unknown as typeof fetch };
  expect(await runCli(["chatgpt", "connect", "--json"], dependencies)).toBe(2);
  expect(output).toContain("confirmation_required"); output = "";
  expect(await runCli(["chatgpt", "connect", "--yes", "--json"], dependencies)).toBe(2);
  expect(output).toContain("personal_login_required");
  expect(requests).toBe(0); expect(output).not.toContain("workspace-key");
});

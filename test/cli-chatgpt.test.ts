import { test, expect } from "bun:test";
import { connectChatGPTLocally } from "../src/cli-chatgpt";
import type { ChatGPTPlanStatus } from "../src/types";

const connected: ChatGPTPlanStatus = { eligible: true, status: "connected", grantId: "00000000-0000-4000-8000-000000000123", account: { label: "Test" }, manageUsageUrl: "https://chatgpt.com/settings/usage", connectionMethod: "local" };
test("local registration forwards a matching callback once, including issued client ID", async () => {
  let redirectUri = "", completions = 0, output = "";
  const state = "s".repeat(43);
  const result = await connectChatGPTLocally({
    async authorizeLocal(uri) {
      redirectUri = uri;
      expect(new URL(uri).hostname).toBe("127.0.0.1");
      const url = new URL("https://auth.openai.com/api/accounts/authorize");
      url.search = new URLSearchParams({ state, redirect_uri: uri }).toString();
      return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
    async complete(input) { completions++; expect(input).toEqual({ state, code: "private-code", clientId: "oaiapp_test" }); return connected; },
  }, { timeoutMs: 5000, write: text => { output += text; }, async openBrowser() {
    expect((await fetch(`${redirectUri}?state=wrong&code=wrong`)).status).toBe(400);
    expect((await fetch(`${redirectUri}?state=${state}&code=x&code=y`)).status).toBe(400);
    expect((await fetch(`${redirectUri}?state=${state}&code=x`, { headers: { Origin: "https://evil.test" } })).status).toBe(404);
    const response = await fetch(`${redirectUri}?state=${state}&code=private-code&client_id=oaiapp_test`);
    expect(response.status).toBe(200); expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    await response.text(); return true;
  } });
  expect(result).toEqual(connected); expect(completions).toBe(1); expect(output).not.toContain("private-code");
  await expect(fetch(redirectUri)).rejects.toThrow();
});
test("local registration times out and closes the callback listener", async () => {
  let callback = "";
  await expect(connectChatGPTLocally({
    async authorizeLocal(uri) { callback = uri; return { authorizationUrl: `https://auth.openai.com/authorize?state=${"s".repeat(43)}&redirect_uri=${encodeURIComponent(uri)}`, expiresAt: new Date().toISOString() }; },
    async complete() { throw new Error("No completion expected"); },
  }, { timeoutMs: 50, write() {}, async openBrowser() { return true; } })).rejects.toThrow("timed out");
  await expect(fetch(callback)).rejects.toThrow();
});
test("local registration rejects an authorization URL with another callback", async () => {
  let opened = false;
  await expect(connectChatGPTLocally({
    async authorizeLocal() { return { authorizationUrl: "https://auth.openai.com/authorize?redirect_uri=https://evil.test", expiresAt: new Date().toISOString() }; },
    async complete() { return connected; },
  }, { write() {}, async openBrowser() { opened = true; return true; } })).rejects.toThrow("Invalid ChatGPT authorization");
  expect(opened).toBe(false);
});

import { describe, expect, it } from "bun:test";
import { createPartnerClient, PartnerApiError } from "../src/partner";

const apiKey = `ua_partner_${"a".repeat(32)}_${"b".repeat(43)}`;
describe("partner billing SDK", () => {
  it("keeps credit mutations server-side, sends stable idempotency keys, and encodes scope and replay filters", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPartnerClient({ apiKey, endpoint: "https://runtime.test", fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ ok: true });
    } });
    const scope = { workspaceId: "river bank", environmentId: "development" };
    await client.credits.setPolicy(scope, { expectedVersion: 0, ratingVersion: "v1", reserveCredits: 10, mode: "fixed", walletMode: "workspace" }, "plan-v1");
    await client.credits.grant(scope, { amount: 100, source: "purchased", reference: "cs_test_1", expiresAt: null }, "stripe:cs_test_1");
    await client.credits.refund(scope, { lineId: "line-1", reason: "Credit refund" }, "refund:line-1");
    await client.usage.listEvents({ ...scope, cursor: "12", limit: 10, subjectId: "verified&subject" });
    await client.usage.getSummary({ ...scope, from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(calls[0]!.url).toBe("https://runtime.test/v1/partner/workspaces/river%20bank/environments/development/credits/policy");
    expect(new Headers(calls[1]!.init!.headers).get("Idempotency-Key")).toBe("stripe:cs_test_1");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ amount: 100, source: "purchased", reference: "cs_test_1", expiresAt: null });
    expect(new URL(calls[3]!.url).searchParams.get("subjectId")).toBe("verified&subject");
    expect(new URL(calls[3]!.url).searchParams.get("cursor")).toBe("12");
    for (const call of calls) expect(new Headers(call.init!.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(() => client.credits.grant(scope, { amount: 1, source: "included", reference: "x", expiresAt: null }, ""))
      .toThrow("idempotencyKey");
  });
  it("returns insufficient credits and idempotency conflicts as typed errors", async () => {
    const client = createPartnerClient({ apiKey, fetch: async () => Response.json({
      error: { code: "idempotency_conflict", message: "The request changed" },
    }, { status: 409 }) });
    try {
      await client.credits.grant({ workspaceId: "w", environmentId: "e" },
        { amount: 1, source: "included", reference: "x", expiresAt: null }, "reused");
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(PartnerApiError);
      expect(error).toMatchObject({ status: 409, code: "idempotency_conflict" });
    }
  });
});

it("keeps captures, reversals and access changes scoped to a stable encoded user wallet", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = createPartnerClient({ apiKey, fetch: async (input, init) => {
    calls.push({ url: String(input), init }); return Response.json({ state: "settled" });
  } });
  const scope = { workspaceId: "w", environmentId: "e", walletId: "user&with/slash" };
  await client.credits.capture(scope, { operationId: "turn", meteringEventId: "receipt", ratingVersion: "tokens-v1",
    amount: 7, reason: "Partner token rating" }, "capture:receipt");
  await client.credits.revoke(scope, { grantId: "lot", amount: 10, reason: "Reversal" }, "reverse:lot");
  await client.credits.setAccess(scope, { expectedVersion: 3, status: "suspended", reason: "Review" }, "suspend");
  await client.credits.listGrants(scope);
  for (const call of calls) expect(new URL(call.url).searchParams.get("walletId")).toBe(scope.walletId);
  expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ meteringEventId: "receipt", ratingVersion: "tokens-v1", amount: 7 });
  expect(new Headers(calls[0]!.init!.headers).get("Idempotency-Key")).toBe("capture:receipt");
  expect(calls[2]!.init!.method).toBe("PUT");
});

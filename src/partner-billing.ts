/** Partner owns subscriptions, payments and rating. These APIs only move product credits. */
export type CreditScope = { workspaceId: string; environmentId: string; walletId?: string };
export type CreditPolicy = { expectedVersion: number; ratingVersion: string;
  mode: "fixed" | "partner_rated"; reserveCredits: number; walletMode: "workspace" | "member" };
export type CreditGrant = { amount: number; source: "included" | "purchased" | "promotion" | "adjustment";
  reference: string; expiresAt: string | null };
export type CreditCapture = { operationId: string; meteringEventId: string; ratingVersion: string;
  amount: number; reason: string };
export type CreditMetering = { outcome: string; coverage: "checkpointed_steps_only";
  steps: Array<{ modelStep: number; provider: string; model: string; modelProfileId: string | null;
    inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number }> };
export type CreditBalance = CreditScope & {
  available: number; held: number; consumed: number; expired: number; revoked: number;
  granted: number; credited: number; pending: number;
  policy: Omit<CreditPolicy, "expectedVersion"> & { version: number } | null;
  access: { version: number; status: "active" | "suspended" };
  asOf: string; watermark: number; freshness: "authoritative";
};
export type CreditEvent = CreditScope & { sequence: number; eventId: string; type: string;
  occurredAt: string; operationId: string | null; subjectId: string | null; data: Record<string, unknown> };
export type CreditGrantLot = Omit<CreditGrant, "amount" | "source"> & { source: CreditGrant["source"] | "refund"; grantId: string; original: number;
  available: number; held: number; consumed: number; expired: number; revoked: number };
export type UsageQuery = Partial<CreditScope> & { subjectId?: string; cursor?: string; limit?: number; from?: string; to?: string };
export type UsageEvents = { data: CreditEvent[]; cursor: string | null; watermark: number };
export type UsageSummary = { data: Array<CreditScope & { currency: string; settledTurns: number; codeSpringAmount: number; credits: number }>;
  asOf: string; watermark: number; basis: "settled_at"; invoiceStatus: "not_invoiced" };
type Request = <T>(path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string }) => Promise<T>;
export function partnerBilling(request: Request) {
  const path = (scope: CreditScope, operation: string) => {
    if (!scope.workspaceId || !scope.environmentId) throw new Error("Workspace and environment are required");
    return `/workspaces/${encodeURIComponent(scope.workspaceId)}/environments/${encodeURIComponent(scope.environmentId)}/credits/${operation}` +
      (scope.walletId === undefined ? "" : `?walletId=${encodeURIComponent(scope.walletId)}`);
  };
  function key(value: string) {
    if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(value)) throw new Error("A valid idempotencyKey is required");
    return value;
  }
  const query = (input: UsageQuery) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(input)) if (value !== undefined) params.set(name, String(value));
    return params.size ? `?${params}` : "";
  };
  const getBalance = (scope: CreditScope) => request<CreditBalance>(path(scope, "balance"));
  function mutate<T>(scope: CreditScope, operation: string, body: unknown, idempotencyKey: string, method = "POST") {
    return request<T>(path(scope, operation), { method, body, idempotencyKey: key(idempotencyKey) });
  }
  return {
    credits: {
      getBalance,
      listGrants(scope: CreditScope) { return request<{ data: CreditGrantLot[] }>(path(scope, "grants")); },
      setPolicy(scope: CreditScope, input: CreditPolicy, idempotencyKey: string) {
        return mutate<NonNullable<CreditBalance["policy"]>>(scope, "policy", input, idempotencyKey, "PUT");
      },
      setAccess(scope: CreditScope, input: { expectedVersion: number; status: "active" | "suspended"; reason: string }, idempotencyKey: string) {
        return mutate<CreditBalance["access"]>(scope, "access", input, idempotencyKey, "PUT");
      },
      grant(scope: CreditScope, input: CreditGrant, idempotencyKey: string) {
        return mutate<{ grantId: string; amount: number }>(scope, "grants", input, idempotencyKey);
      },
      capture(scope: CreditScope, input: CreditCapture, idempotencyKey: string) {
        return mutate<{ state: "settled"; lineId: string; credits: number }>(scope, "captures", input, idempotencyKey);
      },
      revoke(scope: CreditScope, input: { grantId: string; amount: number; reason: string }, idempotencyKey: string) {
        return mutate<{ grantId: string; amount: number }>(scope, "revocations", input, idempotencyKey);
      },
      refund(scope: CreditScope, input: { lineId: string; reason: string }, idempotencyKey: string) {
        return mutate<{ grantId: string; amount: number; adjustsLineId: string }>(scope, "refunds", input, idempotencyKey);
      },
    },
    usage: {
      getBalance,
      listEvents(input: UsageQuery = {}) { return request<UsageEvents>(`/usage/events${query(input)}`); },
      getSummary(input: Omit<UsageQuery, "cursor" | "limit"> = {}) { return request<UsageSummary>(`/usage/summary${query(input)}`); },
    },
  };
}

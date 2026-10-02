/** Server-only CodeSpring partner administration client. Never bundle the key in a browser. */
export type PartnerScope =
  | "partner:workspaces:read" | "partner:workspaces:write"
  | "partner:users:read" | "partner:users:write" | "partner:users:erase"
  | "partner:builder:delegate" | "partner:agents:clone"
  | "partner:policies:read" | "partner:policies:write"
  | "partner:templates:read" | "partner:templates:write";

export type PartnerTemplate = {
  templateId: string; version: number; title: string; summary: string;
  category: "support" | "research" | "operations" | "sales" | "custom";
  icon: "sparkles" | "message-square" | "search" | "workflow" | "briefcase";
  agent: { description: string; instructions: string; maxModelSteps: number; maxToolCalls: number };
  contentDigest: string; sourceRevisionId: string; createdAt: string;
};

export type HostedWorkspaceLimits = {
  workspaceId: string; version: number; accountMaxDailyTurns: number;
  maxDailyTurns: number; defaultMemberMaxDailyTurns: number;
};
export type HostedMemberLimits = {
  membershipId: string; workspaceId: string; externalUserId: string;
  version: number; maxDailyTurns: number | null; effectiveMaxDailyTurns: number;
};
export type HostedTurnBalance = {
  workspaceId: string; membershipId: string | null; utcDay: string; asOf: string;
  balances: Array<{ scope: "account" | "workspace" | "member";
    limit: number; reserved: number; consumed: number; remaining: number }>;
};

export type HostedWorkspace = {
  workspaceId: string;
  externalCustomerId: string;
  displayName: string;
  status: "active" | "suspended";
  environments: Array<{ id: string; kind: "development" | "production" }>;
  createdAt: string;
};
export type HostedMember = {
  membershipId: string;
  subjectId: string;
  partnerSubjectId: string;
  externalUserId: string | null;
  displayName: string | null;
  role: "end_user" | "viewer" | "builder" | "publisher" | "admin";
  status: "active" | "suspended" | "erased";
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type PartnerSubject = {
  partnerSubjectId: string;
  externalUserId: string | null;
  status: "active" | "suspended" | "erased";
  version: number;
  generation: number;
  membershipCount: number;
  erasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PartnerSubjectDetail = PartnerSubject & {
  memberships: Array<{ workspaceId: string; membershipId: string;
    workspaceSubjectId: string; role: HostedMember["role"];
    status: HostedMember["status"]; membershipVersion: number }>;
};
export type PartnerProvisioning = {
  utcDay: string;
  maxSubjects: number;
  maxMembersPerWorkspace: number;
  maxNewSubjectsPerDay: number;
  maxNewMembersPerDay: number;
  subjectCount: number;
  newSubjectsToday: number;
  newMembersToday: number;
};
export type WorkspaceProvisioning = {
  workspaceId: string; maxMembers: number; memberCount: number;
};
export type PartnerSubjectErasure = {
  operationId: string; partnerSubjectId: string;
  status: "pending" | "processing" | "completed" | "attention";
  sessionsErased: number; lastError: string | null;
  requestedAt: string; updatedAt: string; completedAt: string | null;
};
export type PartnerClientOptions = {
  apiKey: string;
  endpoint?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
export class PartnerApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PartnerApiError";
  }
}

export function createPartnerClient(options: PartnerClientOptions) {
  if (typeof window !== "undefined") throw new Error("Partner keys must only be used on a server");
  if (!/^ua_partner_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(options.apiKey))
    throw new Error("A valid CodeSpring partner key is required");
  const endpoint = (options.endpoint ?? "https://api.agents.codespring.app").replace(/\/$/, "");
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== "function") throw new Error("Fetch is required");

  async function request<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const headers = new Headers({ Authorization: `Bearer ${options.apiKey}` });
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
    const response = await transport(new URL(`/v1/partner${path}`, endpoint), {
      method: init.method ?? "GET", headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { code?: string; message?: string } }).error : undefined;
      throw new PartnerApiError(response.status, error?.code ?? "partner_request_failed",
        error?.message ?? `CodeSpring partner API returned HTTP ${response.status}`);
    }
    return payload as T;
  }
  function workspacePath(workspaceId: string): string {
    if (!workspaceId) throw new Error("workspaceId is required");
    return `/workspaces/${encodeURIComponent(workspaceId)}`;
  }

  return {
    workspaces: {
      create(input: { externalCustomerId: string; displayName: string; idempotencyKey: string }) {
        const { idempotencyKey, ...body } = input;
        if (!idempotencyKey) throw new Error("idempotencyKey is required");
        return request<HostedWorkspace>("/workspaces", { method: "POST", body, idempotencyKey });
      },
      get(workspaceId: string) { return request<HostedWorkspace>(workspacePath(workspaceId)); },
      list(externalCustomerId?: string) {
        const query = externalCustomerId === undefined ? "" : `?externalCustomerId=${encodeURIComponent(externalCustomerId)}`;
        return request<{ data: HostedWorkspace[] }>(`/workspaces${query}`);
      },
      suspend(workspaceId: string) {
        return request<HostedWorkspace>(`${workspacePath(workspaceId)}/suspend`, { method: "POST" });
      },
      resume(workspaceId: string) {
        return request<HostedWorkspace>(`${workspacePath(workspaceId)}/resume`, { method: "POST" });
      },
    },
    members: {
      upsert(workspaceId: string, input: { externalUserId: string; role: HostedMember["role"]; displayName?: string }) {
        return request<HostedMember>(`${workspacePath(workspaceId)}/members`, { method: "POST", body: input });
      },
      list(workspaceId: string) {
        return request<{ data: HostedMember[] }>(`${workspacePath(workspaceId)}/members`);
      },
      suspend(workspaceId: string, memberId: string) {
        return request<HostedMember>(`${workspacePath(workspaceId)}/members/${encodeURIComponent(memberId)}/suspend`, { method: "POST" });
      },
    },
    subjects: {
      list(input: { externalUserId?: string; limit?: number; cursor?: string } = {}) {
        const query = new URLSearchParams();
        if (input.externalUserId !== undefined) query.set("externalUserId", input.externalUserId);
        if (input.limit !== undefined) query.set("limit", String(input.limit));
        if (input.cursor) query.set("cursor", input.cursor);
        return request<{ data: PartnerSubject[]; cursor: string | null }>(
          `/subjects${query.size ? `?${query}` : ""}`);
      },
      get(partnerSubjectId: string) {
        return request<PartnerSubjectDetail>(`/subjects/${encodeURIComponent(partnerSubjectId)}`);
      },
      suspend(partnerSubjectId: string, expectedVersion: number) {
        return request<PartnerSubjectDetail>(
          `/subjects/${encodeURIComponent(partnerSubjectId)}/suspend`,
          { method: "POST", body: { expectedVersion } });
      },
      resume(partnerSubjectId: string, expectedVersion: number) {
        return request<PartnerSubjectDetail>(
          `/subjects/${encodeURIComponent(partnerSubjectId)}/resume`,
          { method: "POST", body: { expectedVersion } });
      },
      erase(partnerSubjectId: string, input: { expectedVersion: number; operationId: string }) {
        return request<PartnerSubjectErasure>(
          `/subjects/${encodeURIComponent(partnerSubjectId)}/erase`,
          { method: "POST", body: input });
      },
      erasureStatus(partnerSubjectId: string) {
        return request<PartnerSubjectErasure>(
          `/subjects/${encodeURIComponent(partnerSubjectId)}/erasure`);
      },
    },
    provisioning: {
      get() { return request<PartnerProvisioning>("/provisioning"); },
      getWorkspace(workspaceId: string) {
        return request<WorkspaceProvisioning>(`${workspacePath(workspaceId)}/provisioning`);
      },
    },
    limits: {
      get(workspaceId: string) {
        return request<HostedWorkspaceLimits>(`${workspacePath(workspaceId)}/limits`);
      },
      update(workspaceId: string, input: {
        expectedVersion: number; maxDailyTurns: number; defaultMemberMaxDailyTurns: number;
      }) {
        return request<HostedWorkspaceLimits>(`${workspacePath(workspaceId)}/limits`, { method: "PUT", body: input });
      },
      balance(workspaceId: string) {
        return request<HostedTurnBalance>(`${workspacePath(workspaceId)}/limits/balance`);
      },
      getMember(workspaceId: string, memberId: string) {
        return request<HostedMemberLimits>(`${workspacePath(workspaceId)}/members/${encodeURIComponent(memberId)}/limits`);
      },
      updateMember(workspaceId: string, memberId: string, input: {
        expectedVersion: number; maxDailyTurns: number | null;
      }) {
        return request<HostedMemberLimits>(`${workspacePath(workspaceId)}/members/${encodeURIComponent(memberId)}/limits`,
          { method: "PUT", body: input });
      },
      memberBalance(workspaceId: string, memberId: string) {
        return request<HostedTurnBalance>(`${workspacePath(workspaceId)}/members/${encodeURIComponent(memberId)}/limits/balance`);
      },
    },
    builder: {
      createSession(workspaceId: string, input: { externalUserId: string; environmentId: string; returnPath?: string }) {
        return request<{ launchUrl: string; expiresAt: string }>(
          `${workspacePath(workspaceId)}/builder-sessions`, { method: "POST", body: input });
      },
    },
    runtime: {
      createClientToken(workspaceId: string, input: {
        externalUserId: string; environmentId: string; allowedAgentIds: string[];
        origin: string; expiresInSeconds?: number;
      }) {
        return request<{ token: string; expiresAt: string; subjectId: string }>(
          `${workspacePath(workspaceId)}/client-tokens`, { method: "POST", body: input });
      },
    },
    agents: {
      clone(workspaceId: string, sourceAgentId: string, input: {
        operationId: string; environmentId: string; sourceRevisionId: string;
        agentId: string; displayName: string; sourceWorkspaceId?: string;
        sourceEnvironmentId?: string; modelProfileId?: string;
      }) {
        return request<{ agent: { agentId: string; currentRevisionId: string | null }; sourceRevisionId: string }>(
          `${workspacePath(workspaceId)}/agents/${encodeURIComponent(sourceAgentId)}/clone`,
          { method: "POST", body: input });
      },
    },
    templates: {
      publish(input: {
        operationId: string; templateId: string; expectedVersion: number;
        title: string; summary: string; category: PartnerTemplate["category"];
        icon: PartnerTemplate["icon"]; sourceWorkspaceId: string;
        sourceEnvironmentId: string; sourceAgentId: string; sourceRevisionId: string;
        reviewedPortableContent: true;
      }) {
        return request<PartnerTemplate>("/templates", { method: "POST", body: input });
      },
      list(input: { limit?: number; cursor?: string } = {}) {
        const query = new URLSearchParams();
        if (input.limit !== undefined) query.set("limit", String(input.limit));
        if (input.cursor) query.set("cursor", input.cursor);
        return request<{ data: PartnerTemplate[]; cursor: string | null }>(
          `/templates${query.size ? `?${query}` : ""}`);
      },
      get(templateId: string, version?: number) {
        return request<PartnerTemplate>(`/templates/${encodeURIComponent(templateId)}` +
          (version === undefined ? "" : `?version=${encodeURIComponent(version)}`));
      },
      install(workspaceId: string, templateId: string, input: {
        operationId: string; version: number; environmentId: string;
        agentId: string; displayName: string; modelProfileId: string;
      }) {
        return request<{ agent: { agentId: string; currentRevisionId: string | null };
          templateId: string; version: number }>(
          `${workspacePath(workspaceId)}/templates/${encodeURIComponent(templateId)}/install`,
          { method: "POST", body: input });
      },
    },
  };
}

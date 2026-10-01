/** Server-only CodeSpring partner administration client. Never bundle the key in a browser. */
export type PartnerScope =
  | "partner:workspaces:read" | "partner:workspaces:write"
  | "partner:users:read" | "partner:users:write"
  | "partner:builder:delegate" | "partner:agents:clone";

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
  externalUserId: string;
  displayName: string | null;
  role: "end_user" | "viewer" | "builder" | "publisher" | "admin";
  status: "active" | "suspended";
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
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
  };
}

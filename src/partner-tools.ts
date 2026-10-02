import {
  createToolHandler, CustomerToolError, defineTool,
  type CustomerHostedToolDefinition, type ToolExecutionContext,
  type ToolHandlerOptions,
} from "./tools";

export type UserMemoryNamespace = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

export type UserMemoryItem = {
  id: string;
  revision: string;
  content: string;
};

export interface UserMemoryStore {
  /** Return only records currently visible to this exact subject. */
  search(input: { namespace: UserMemoryNamespace; query: string; limit: number;
    signal: AbortSignal }): Promise<readonly UserMemoryItem[]>;
  /** Fail closed unless every exact record revision is still visible. Called on cached replay too. */
  assertReadable(input: { namespace: UserMemoryNamespace;
    records: readonly Pick<UserMemoryItem, "id" | "revision">[];
    signal: AbortSignal }): Promise<void>;
  /** Create a pending proposal only, idempotently by operation ID. A user confirms it outside the agent tool. */
  propose(input: { namespace: UserMemoryNamespace; content: string;
    operationId: string; signal: AbortSignal }): Promise<{ proposalId: string }>;
  /** Fail closed unless a pending proposal still belongs to this subject. */
  assertProposalVisible(input: { namespace: UserMemoryNamespace; proposalId: string;
    signal: AbortSignal }): Promise<void>;
}

export type UserMemoryToolsOptions = Pick<ToolHandlerOptions,
  "endpoint" | "executionStore" | "issuer" | "jwksUrl" | "jwks"> & {
  revision: string;
  /** Resolve current application identity from the signed session, not model input. */
  resolveSubject(context: ToolExecutionContext): Promise<UserMemoryNamespace | null>;
  /** Check live consent, membership, and memory policy on every delivery. */
  authorize(input: { namespace: UserMemoryNamespace; action: "search" | "propose";
    context: ToolExecutionContext }): Promise<void>;
  store: UserMemoryStore;
  maxResults?: number;
  maxItemBytes?: number;
};

/** Partner-owned memory search and proposal tools with live output checks on replay. */
export function createUserMemoryTools(options: UserMemoryToolsOptions): {
  tools: readonly CustomerHostedToolDefinition[];
  handler: (request: Request) => Promise<Response>;
} {
  const maxResults = options.maxResults ?? 5;
  const maxItemBytes = options.maxItemBytes ?? 4096;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10 ||
      !Number.isSafeInteger(maxItemBytes) || maxItemBytes < 1 || maxItemBytes > 16_384) {
    throw new TypeError("Memory limits are invalid");
  }
  const resolve = async (context: ToolExecutionContext): Promise<UserMemoryNamespace> => {
    if (!context.sessionId || !context.subjectId)
      throw new CustomerToolError("memory_subject_required", "Authenticated subject is required");
    const namespace = await options.resolveSubject(context);
    if (!namespace || !namespace.accountId || namespace.workspaceId !== context.tenantId ||
        namespace.subjectId !== context.subjectId)
      throw new CustomerToolError("memory_access_denied", "Memory access is unavailable");
    return namespace;
  };
  const authorize = async (context: ToolExecutionContext, action: "search" | "propose") => {
    const namespace = await resolve(context);
    await options.authorize({ namespace, action, context });
    return namespace;
  };
  const search = defineTool<{ query: string; limit?: number }, { items: UserMemoryItem[] }>({
    name: "search_my_memory", revision: options.revision,
    description: "Search this user's approved personal memory.", risk: "read",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: 512 },
      limit: { type: "integer", minimum: 1, maximum: maxResults },
    }, required: ["query"], additionalProperties: false },
    async execute(input, context) {
      const namespace = await authorize(context, "search");
      const items = await options.store.search({ namespace, query: input.query,
        limit: input.limit ?? maxResults, signal: context.signal });
      if (items.length > (input.limit ?? maxResults))
        throw new CustomerToolError("memory_result_invalid", "Memory results exceed the limit");
      const encoder = new TextEncoder();
      for (const item of items) {
        if (!item || typeof item.id !== "string" || !item.id || item.id.length > 128 ||
            typeof item.revision !== "string" || !item.revision || item.revision.length > 128 ||
            typeof item.content !== "string" || encoder.encode(item.content).byteLength > maxItemBytes)
          throw new CustomerToolError("memory_result_invalid", "Memory result is invalid");
      }
      return { items: items.map(item => ({ id: item.id, revision: item.revision,
        content: item.content })) };
    },
  });
  const propose = defineTool<{ content: string }, { proposalId: string; status: "pending_confirmation" }>({
    name: "propose_my_memory", revision: options.revision,
    description: "Propose a personal memory for the user to review and confirm.", risk: "write",
    inputSchema: { type: "object", properties: {
      content: { type: "string", minLength: 1, maxLength: maxItemBytes },
    }, required: ["content"], additionalProperties: false },
    async execute(input, context) {
      const namespace = await authorize(context, "propose");
      if (new TextEncoder().encode(input.content).byteLength > maxItemBytes)
        throw new CustomerToolError("memory_proposal_too_large", "Memory proposal is too large");
      const result = await options.store.propose({ namespace, content: input.content,
        operationId: context.operationId, signal: context.signal });
      if (!result || typeof result.proposalId !== "string" || !result.proposalId ||
          result.proposalId.length > 128)
        throw new CustomerToolError("memory_proposal_invalid", "Memory proposal is invalid");
      return { proposalId: result.proposalId, status: "pending_confirmation" };
    },
  });
  const tools = [search, propose] as const;
  const handler = createToolHandler({
    endpoint: options.endpoint, executionStore: options.executionStore,
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.jwksUrl === undefined ? {} : { jwksUrl: options.jwksUrl }),
    ...(options.jwks === undefined ? {} : { jwks: options.jwks }),
    tools,
    async authorize(context, input) {
      await authorize(context, "query" in input ? "search" : "propose");
    },
    async authorizeResult(context, input, output) {
      const namespace = await authorize(context, "query" in input ? "search" : "propose");
      if ("query" in input) {
        const result = output as { items?: unknown };
        if (!result || !Array.isArray(result.items) ||
            result.items.length > (typeof input.limit === "number" ? input.limit : maxResults))
          throw new CustomerToolError("memory_result_invalid", "Memory result is invalid");
        const encoder = new TextEncoder();
        const records = result.items.map(item => {
          if (!item || typeof item.id !== "string" || !item.id || item.id.length > 128 ||
              typeof item.revision !== "string" || !item.revision || item.revision.length > 128 ||
              typeof item.content !== "string" || encoder.encode(item.content).byteLength > maxItemBytes)
            throw new CustomerToolError("memory_result_invalid", "Memory result is invalid");
          return { id: item.id, revision: item.revision };
        });
        await options.store.assertReadable({ namespace, records, signal: context.signal });
      } else {
        const result = output as { proposalId?: unknown; status?: unknown };
        if (!result || typeof result.proposalId !== "string" || !result.proposalId ||
            result.proposalId.length > 128 || result.status !== "pending_confirmation")
          throw new CustomerToolError("memory_proposal_invalid", "Memory proposal is invalid");
        await options.store.assertProposalVisible({ namespace,
          proposalId: result.proposalId, signal: context.signal });
      }
    },
  });
  return { tools, handler };
}

export type PendingUserMemoryProposal = {
  namespace: UserMemoryNamespace;
  id: string;
  revision: string;
  content: string;
  status: "pending";
};

export interface UserMemoryAdminStore {
  /** Filter by namespace and current consent in the partner store. */
  getProposal(input: { namespace: UserMemoryNamespace; proposalId: string;
    signal: AbortSignal }): Promise<PendingUserMemoryProposal | null>;
  /** Atomically check proposal revision, content digest, idempotency, current consent, and all write limits before saving. */
  commitApproved(input: { namespace: UserMemoryNamespace; proposalId: string;
    expectedRevision: string; expectedContentDigest: string; operationId: string;
    limits: UserMemoryWriteLimits; signal: AbortSignal }): Promise<UserMemoryItem>;
  list(input: { namespace: UserMemoryNamespace; limit: number; cursor?: string;
    signal: AbortSignal }): Promise<{ items: UserMemoryItem[]; cursor: string | null }>;
  /** Atomically tombstone the exact revision; operation ID makes retries safe. */
  forget(input: { namespace: UserMemoryNamespace; id: string;
    expectedRevision: string; operationId: string; signal: AbortSignal }): Promise<void>;
}

export type UserMemoryWriteLimits = {
  maxItems: number;
  maxWritesPerDay: number;
  maxStoredBytes: number;
  maxItemBytes: number;
};

export type UserMemoryServiceOptions = {
  /** Resolve the current authenticated user from the partner application request. */
  resolveUser(request: Request): Promise<UserMemoryNamespace | null>;
  /** Check live consent and membership for every user action. */
  authorize(input: { namespace: UserMemoryNamespace;
    action: "get_proposal" | "confirm" | "list" | "forget";
    request: Request }): Promise<void>;
  store: UserMemoryAdminStore;
  limits: UserMemoryWriteLimits;
};

/** Server-only operations for a partner UI. No agent tool can confirm or forget memory. */
export function createUserMemoryService(options: UserMemoryServiceOptions) {
  const limits = Object.freeze({ ...options.limits });
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError("Memory write limits must be positive integers");
  }
  if (limits.maxItemBytes > limits.maxStoredBytes)
    throw new TypeError("Item byte limit exceeds stored byte limit");
  const resolve = async (request: Request, action: Parameters<UserMemoryServiceOptions["authorize"]>[0]["action"]) => {
    const namespace = await options.resolveUser(request);
    if (!namespace || !namespace.accountId || !namespace.workspaceId || !namespace.subjectId)
      throw new CustomerToolError("memory_subject_required", "Authenticated subject is required");
    await options.authorize({ namespace, action, request });
    return namespace;
  };
  return {
    async getProposal(request: Request, proposalId: string) {
      requireMemoryId(proposalId);
      const namespace = await resolve(request, "get_proposal");
      const proposal = await options.store.getProposal({ namespace, proposalId, signal: request.signal });
      if (!proposal || proposal.status !== "pending" || !sameNamespace(proposal.namespace, namespace) ||
          proposal.id !== proposalId || !proposal.revision || proposal.revision.length > 128 ||
          typeof proposal.content !== "string" || !proposal.content ||
          new TextEncoder().encode(proposal.content).byteLength > limits.maxItemBytes)
        throw new CustomerToolError("memory_proposal_unavailable", "Memory proposal is unavailable");
      return { proposalId, revision: proposal.revision, content: proposal.content,
        contentDigest: await contentDigest(proposal.content), audience: "personal" as const };
    },
    async confirm(request: Request, input: { proposalId: string; expectedRevision: string;
      expectedContentDigest: string; operationId: string }) {
      requireMemoryId(input.proposalId);
      requireMemoryId(input.expectedRevision);
      requireOperationId(input.operationId);
      if (!/^[a-f0-9]{64}$/u.test(input.expectedContentDigest))
        throw new TypeError("Expected content digest is invalid");
      const namespace = await resolve(request, "confirm");
      const item = await options.store.commitApproved({ namespace,
        proposalId: input.proposalId, expectedRevision: input.expectedRevision,
        expectedContentDigest: input.expectedContentDigest, operationId: input.operationId,
        limits, signal: request.signal });
      requireMemoryItem(item, limits.maxItemBytes);
      return item;
    },
    async list(request: Request, input: { limit?: number; cursor?: string } = {}) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError("Memory list limit must be between 1 and 100");
      if (input.cursor !== undefined && (input.cursor.length < 1 || input.cursor.length > 2048))
        throw new TypeError("Memory cursor is invalid");
      const namespace = await resolve(request, "list");
      const result = await options.store.list({ namespace, limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }), signal: request.signal });
      if (!result || !Array.isArray(result.items) || result.items.length > limit ||
          (result.cursor !== null && (typeof result.cursor !== "string" ||
            result.cursor.length < 1 || result.cursor.length > 2048)))
        throw new CustomerToolError("memory_result_invalid", "Memory result is invalid");
      for (const item of result.items) requireMemoryItem(item, limits.maxItemBytes);
      return result;
    },
    async forget(request: Request, input: { id: string; expectedRevision: string; operationId: string }) {
      requireMemoryId(input.id);
      requireMemoryId(input.expectedRevision);
      requireOperationId(input.operationId);
      const namespace = await resolve(request, "forget");
      await options.store.forget({ namespace, id: input.id,
        expectedRevision: input.expectedRevision, operationId: input.operationId,
        signal: request.signal });
      return { id: input.id, status: "forgotten" as const };
    },
  };
}

function sameNamespace(left: UserMemoryNamespace, right: UserMemoryNamespace): boolean {
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId &&
    left.subjectId === right.subjectId;
}
function requireMemoryId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    throw new TypeError("Memory ID is invalid");
}
function requireOperationId(value: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    throw new TypeError("Memory operation ID must be a UUID");
}
function requireMemoryItem(item: UserMemoryItem, maxItemBytes: number): void {
  if (!item || typeof item.id !== "string" || !item.id || item.id.length > 128 ||
      typeof item.revision !== "string" || !item.revision || item.revision.length > 128 ||
      typeof item.content !== "string" || new TextEncoder().encode(item.content).byteLength > maxItemBytes)
    throw new CustomerToolError("memory_result_invalid", "Memory result is invalid");
}
async function contentDigest(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

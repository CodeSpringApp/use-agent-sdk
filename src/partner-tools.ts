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
  /** Create a pending proposal only. A partner-authenticated user confirms it outside the agent tool. */
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
  const search = defineTool<{ query: string; limit?: number }, { items: UserMemoryItem[] }>({
    name: "search_my_memory", revision: options.revision,
    description: "Search this user's approved personal memory.", risk: "read",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: 512 },
      limit: { type: "integer", minimum: 1, maximum: maxResults },
    }, required: ["query"], additionalProperties: false },
    async execute(input, context) {
      const namespace = await resolve(context);
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
      const namespace = await resolve(context);
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
    async authorize(context) { await resolve(context); },
    async authorizeResult(context, input, output) {
      const namespace = await resolve(context);
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

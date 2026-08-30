import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";

const defaultIssuer = "https://api.agents.codespring.app";
const defaultJwksUrl = `${defaultIssuer}/.well-known/agent-tool-jwks.json`;
const tokenHeader = "CodeSpring-Agent-Tool-JWT";
const maximumBodyBytes = 96 * 1_024;
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

type Primitive = string | number | boolean;
type PrimitiveType = "string" | "number" | "integer" | "boolean";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, {
    type: PrimitiveType | "array";
    description?: string;
    enum?: Primitive[];
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    items?: { type: PrimitiveType; enum?: Primitive[] };
    minItems?: number;
    maxItems?: number;
  }>;
  required: string[];
  additionalProperties: false;
};

export type ToolRisk = "read" | "write";

export interface ToolExecutionContext {
  operationId: string;
  tenantId: string;
  environmentId: string;
  agentRevisionId: string;
  toolId: string;
  toolRevisionId: string;
  signal: AbortSignal;
}

export interface CustomerHostedToolOptions<
  Input extends Record<string, unknown>,
  Output,
> {
  name: string;
  revision: string;
  description: string;
  inputSchema: ToolInputSchema;
  risk?: ToolRisk;
  execute(input: Input, context: ToolExecutionContext): Output | Promise<Output>;
}

export interface CustomerHostedToolDefinition<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> {
  readonly kind: "codespring.customer-hosted-tool";
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly risk: ToolRisk;
  readonly execute: CustomerHostedToolOptions<Input, Output>["execute"];
}

export interface CustomerToolInvocation {
  schemaVersion: 1;
  operationId: string;
  tenantId: string;
  environmentId: string;
  agentRevisionId: string;
  toolId: string;
  toolRevisionId: string;
  toolName: string;
  handlerRevision: string;
  input: Record<string, unknown>;
}

export interface CustomerToolSuccess {
  ok: true;
  operationId: string;
  output: unknown;
}

export interface CustomerToolFailure {
  ok: false;
  operationId: string;
  error: { code: string; message: string; retryable: boolean };
}

export type CustomerToolResult = CustomerToolSuccess | CustomerToolFailure;

export interface ToolExecutionStore {
  /** Atomically joins or replays an operation with the same stable operation ID. */
  run(
    operationId: string,
    execute: () => Promise<CustomerToolResult>,
  ): Promise<CustomerToolResult>;
}

export interface ToolHandlerOptions {
  endpoint: string;
  tools: readonly CustomerHostedToolDefinition[];
  executionStore: ToolExecutionStore;
  issuer?: string;
  jwksUrl?: string;
  jwks?: JSONWebKeySet;
}

export class CustomerToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CustomerToolError";
  }
}

export function defineTool<
  Input extends Record<string, unknown>,
  Output,
>(
  options: CustomerHostedToolOptions<Input, Output>,
): CustomerHostedToolDefinition<Input, Output> {
  const name = requirePattern(options.name, namePattern, "tool name");
  const revision = requirePattern(options.revision, revisionPattern, "tool revision");
  const description = options.description.trim();
  if (!description || description.length > 500) {
    throw new TypeError("tool description must be between 1 and 500 characters");
  }
  validateInputSchema(options.inputSchema);
  return Object.freeze({
    kind: "codespring.customer-hosted-tool" as const,
    name,
    revision,
    description,
    inputSchema: deepFreeze(structuredClone(options.inputSchema)),
    risk: options.risk ?? "read",
    execute: options.execute,
  });
}

export function createToolHandler(
  options: ToolHandlerOptions,
): (request: Request) => Promise<Response> {
  const endpoint = normalizeEndpoint(options.endpoint);
  const issuer = normalizeIssuer(options.issuer ?? defaultIssuer);
  if (options.jwks && options.jwksUrl) {
    throw new TypeError("Provide either jwks or jwksUrl, not both");
  }
  const key: JWTVerifyGetKey = options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(options.jwksUrl ?? defaultJwksUrl));
  const tools = new Map<string, CustomerHostedToolDefinition>();
  for (const tool of options.tools) {
    const identity = toolIdentity(tool.name, tool.revision);
    if (tools.has(identity)) throw new TypeError(`Duplicate tool ${identity}`);
    tools.set(identity, tool);
  }

  return async (request) => {
    if (request.method !== "POST") return jsonError(405, "method_not_allowed", "Use POST");
    if (normalizeRequestUrl(request.url) !== endpoint) {
      return jsonError(404, "tool_endpoint_mismatch", "Tool endpoint does not match");
    }
    if (request.headers.get("CodeSpring-Agent-Tool-Version") !== "1") {
      return jsonError(400, "unsupported_tool_protocol", "Tool protocol version is unsupported");
    }
    if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return jsonError(415, "unsupported_media_type", "Tool invocation must be JSON");
    }
    const token = request.headers.get(tokenHeader);
    if (!token) return jsonError(401, "missing_tool_authorization", "Tool authorization is required");

    let body: string;
    let invocation: CustomerToolInvocation;
    try {
      body = await readBoundedBody(request, maximumBodyBytes);
      invocation = parseInvocation(JSON.parse(body));
    } catch (error) {
      const message = error instanceof CustomerToolError ? error.message : "Tool invocation is invalid";
      return jsonError(400, "invalid_tool_invocation", message);
    }

    try {
      const verified = await jwtVerify(token, key, {
        issuer,
        audience: endpoint,
        algorithms: ["ES256"],
        typ: "codespring-agent-tool+jwt",
      });
      const digest = await sha256Base64Url(body);
      const claims = verified.payload;
      if (
        claims.body_sha256 !== digest ||
        claims.jti !== invocation.operationId ||
        claims.sub !== `${invocation.tenantId}:${invocation.environmentId}` ||
        claims.operation_id !== invocation.operationId ||
        claims.tenant_id !== invocation.tenantId ||
        claims.environment_id !== invocation.environmentId ||
        claims.agent_revision_id !== invocation.agentRevisionId ||
        claims.tool_id !== invocation.toolId ||
        claims.tool_revision_id !== invocation.toolRevisionId ||
        claims.tool_name !== invocation.toolName ||
        claims.handler_revision !== invocation.handlerRevision
      ) {
        throw new Error("claims do not match body");
      }
    } catch {
      return jsonError(401, "invalid_tool_authorization", "Tool authorization is invalid");
    }

    const tool = tools.get(toolIdentity(invocation.toolName, invocation.handlerRevision));
    if (!tool) {
      return resultResponse({
        ok: false,
        operationId: invocation.operationId,
        error: {
          code: "tool_handler_not_found",
          message: "The published tool handler revision is unavailable",
          retryable: false,
        },
      });
    }

    try {
      const result = await options.executionStore.run(scopedOperationKey(invocation), async () => {
        try {
          const input = validateToolInput(tool.inputSchema, invocation.input);
          const output = await tool.execute(input, {
            operationId: invocation.operationId,
            tenantId: invocation.tenantId,
            environmentId: invocation.environmentId,
            agentRevisionId: invocation.agentRevisionId,
            toolId: invocation.toolId,
            toolRevisionId: invocation.toolRevisionId,
            signal: request.signal,
          });
          return {
            ok: true,
            operationId: invocation.operationId,
            output: normalizeJsonOutput(output),
          };
        } catch (error) {
          return failureResult(invocation.operationId, error);
        }
      });
      return resultResponse(validateStoredResult(result, invocation.operationId));
    } catch {
      return resultResponse({
        ok: false,
        operationId: invocation.operationId,
        error: {
          code: "tool_execution_store_unavailable",
          message: "Tool execution coordination is unavailable",
          retryable: true,
        },
      }, 503);
    }
  };
}

export function createMemoryToolExecutionStore(options: {
  ttlMs?: number;
  maximumEntries?: number;
} = {}): ToolExecutionStore {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maximumEntries = options.maximumEntries ?? 1_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) throw new TypeError("ttlMs must be at least 1000");
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new TypeError("maximumEntries must be positive");
  }
  const entries = new Map<string, {
    promise: Promise<CustomerToolResult>;
    expiresAt: number | null;
  }>();
  return {
    async run(operationId, execute) {
      const now = Date.now();
      const existing = entries.get(operationId);
      if (existing && (existing.expiresAt === null || existing.expiresAt > now)) {
        return existing.promise;
      }
      if (existing) entries.delete(operationId);
      while (entries.size >= maximumEntries) {
        const completed = [...entries].find(([, entry]) => entry.expiresAt !== null);
        if (!completed) {
          throw new CustomerToolError(
            "tool_execution_store_capacity",
            "Local tool execution store capacity is exhausted",
            true,
          );
        }
        entries.delete(completed[0]);
      }
      const entry: {
        promise: Promise<CustomerToolResult>;
        expiresAt: number | null;
      } = { promise: Promise.resolve(undefined as never), expiresAt: null };
      const promise = execute().then((result) => {
        if (!result.ok && result.error.retryable) {
          entries.delete(operationId);
        } else {
          entry.expiresAt = Date.now() + ttlMs;
        }
        return result;
      }, (error) => {
        entries.delete(operationId);
        throw error;
      });
      entry.promise = promise;
      entries.set(operationId, entry);
      return promise;
    },
  };
}

export async function executeToolLocally<
  Input extends Record<string, unknown>,
  Output,
>(
  tool: CustomerHostedToolDefinition<Input, Output>,
  input: unknown,
  context: Partial<ToolExecutionContext> & { operationId?: string } = {},
): Promise<Output> {
  const operationId = context.operationId ?? crypto.randomUUID();
  return tool.execute(validateToolInput(tool.inputSchema, input) as Input, {
    operationId,
    tenantId: context.tenantId ?? "local",
    environmentId: context.environmentId ?? "local",
    agentRevisionId: context.agentRevisionId ?? "local-agent@1",
    toolId: context.toolId ?? tool.name,
    toolRevisionId: context.toolRevisionId ?? `${tool.name}@1`,
    signal: context.signal ?? new AbortController().signal,
  });
}

function failureResult(operationId: string, error: unknown): CustomerToolFailure {
  if (error instanceof CustomerToolError) {
    return {
      ok: false,
      operationId,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    };
  }
  return {
    ok: false,
    operationId,
    error: { code: "tool_execution_failed", message: "Tool execution failed", retryable: false },
  };
}

function resultResponse(result: CustomerToolResult, status = 200): Response {
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}

function validateStoredResult(
  value: CustomerToolResult,
  operationId: string,
): CustomerToolResult {
  if (!isRecord(value) || value.operationId !== operationId || typeof value.ok !== "boolean") {
    throw new CustomerToolError(
      "tool_execution_store_invalid_result",
      "Tool execution coordination returned an invalid result",
      true,
    );
  }
  if (value.ok) {
    if (!("output" in value)) {
      throw new CustomerToolError(
        "tool_execution_store_invalid_result",
        "Tool execution coordination returned an invalid result",
        true,
      );
    }
    return value;
  }
  if (
    !isRecord(value.error) ||
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string" ||
    typeof value.error.retryable !== "boolean"
  ) {
    throw new CustomerToolError(
      "tool_execution_store_invalid_result",
      "Tool execution coordination returned an invalid result",
      true,
    );
  }
  return value;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new CustomerToolError("tool_invocation_too_large", "Tool invocation is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new CustomerToolError("tool_invocation_too_large", "Tool invocation is too large");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CustomerToolError("invalid_tool_invocation", "Tool invocation is not valid UTF-8");
  }
}

function parseInvocation(value: unknown): CustomerToolInvocation {
  if (!isRecord(value)) throw new CustomerToolError("invalid_tool_invocation", "Tool invocation is invalid");
  const expected = [
    "schemaVersion", "operationId", "tenantId", "environmentId", "agentRevisionId",
    "toolId", "toolRevisionId", "toolName", "handlerRevision", "input",
  ];
  if (Object.keys(value).some((key) => !expected.includes(key)) || value.schemaVersion !== 1) {
    throw new CustomerToolError("invalid_tool_invocation", "Tool invocation is invalid");
  }
  for (const key of expected.slice(1, -1)) {
    if (typeof value[key] !== "string" || value[key].length < 1 || value[key].length > 256) {
      throw new CustomerToolError("invalid_tool_invocation", "Tool invocation is invalid");
    }
  }
  if (!isRecord(value.input)) throw new CustomerToolError("invalid_tool_invocation", "Tool invocation input is invalid");
  return value as unknown as CustomerToolInvocation;
}

function validateToolInput(
  schema: ToolInputSchema,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new CustomerToolError("invalid_tool_arguments", "Tool arguments must be an object");
  const required = new Set(schema.required);
  for (const key of required) {
    if (!(key in value)) throw new CustomerToolError("invalid_tool_arguments", `Missing required argument ${key}`);
  }
  for (const [key, item] of Object.entries(value)) {
    const property = schema.properties[key];
    if (!property) throw new CustomerToolError("invalid_tool_arguments", `Unknown argument ${key}`);
    validateProperty(key, property, item);
  }
  return value;
}

function validateProperty(
  name: string,
  schema: ToolInputSchema["properties"][string],
  value: unknown,
): void {
  if (schema.type === "array") {
    if (!Array.isArray(value) || !schema.items) throw invalidArgument(name);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw invalidArgument(name);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw invalidArgument(name);
    for (const item of value) validatePrimitive(name, schema.items.type, schema.items.enum, item);
    return;
  }
  validatePrimitive(name, schema.type, schema.enum, value);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw invalidArgument(name);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw invalidArgument(name);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw invalidArgument(name);
    if (schema.maximum !== undefined && value > schema.maximum) throw invalidArgument(name);
  }
}

function validatePrimitive(
  name: string,
  type: PrimitiveType,
  enumeration: Primitive[] | undefined,
  value: unknown,
): void {
  const valid = type === "integer"
    ? Number.isSafeInteger(value)
    : typeof value === type && (type !== "number" || Number.isFinite(value));
  if (!valid || (enumeration && !enumeration.includes(value as Primitive))) throw invalidArgument(name);
}

function invalidArgument(name: string): CustomerToolError {
  return new CustomerToolError("invalid_tool_arguments", `Argument ${name} is invalid`);
}

function validateInputSchema(schema: ToolInputSchema): void {
  if (!isRecord(schema) || schema.type !== "object" || schema.additionalProperties !== false) {
    throw new TypeError("inputSchema must be a strict object schema");
  }
  if (!isRecord(schema.properties) || !Array.isArray(schema.required)) {
    throw new TypeError("inputSchema properties and required are invalid");
  }
  for (const key of schema.required) {
    if (!(key in schema.properties)) throw new TypeError(`Required property ${key} is not defined`);
  }
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("endpoint must be an HTTPS URL without credentials, query, or fragment");
  }
  return url.toString();
}

function normalizeRequestUrl(value: string): string {
  return new URL(value).toString();
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function toolIdentity(name: string, revision: string): string {
  return `${name}\u0000${revision}`;
}

function scopedOperationKey(invocation: CustomerToolInvocation): string {
  return `${invocation.tenantId}\u0000${invocation.environmentId}\u0000${invocation.operationId}`;
}

function normalizeJsonOutput(value: unknown): unknown {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CustomerToolError(
      "tool_output_not_json",
      "Tool output must be JSON serializable",
      false,
    );
  }
  if (encoded === undefined) {
    throw new CustomerToolError(
      "tool_output_not_json",
      "Tool output must be JSON serializable",
      false,
    );
  }
  return JSON.parse(encoded) as unknown;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

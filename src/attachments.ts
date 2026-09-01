import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import type { ExternalAssetRef, FetchLike } from "./types";

const defaultIssuer = "https://api.agents.codespring.app";
const defaultJwksUrl = `${defaultIssuer}/.well-known/agent-tool-jwks.json`;
const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const maximumAssetBytes = 20 * 1_024 * 1_024;

export interface AgentAttachmentUploadContext {
  signal: AbortSignal;
}

export interface AgentAttachmentAdapter {
  readonly accept?: string;
  readonly maximumFiles?: number;
  readonly maximumBytes?: number;
  upload(file: File, context: AgentAttachmentUploadContext): Promise<ExternalAssetRef>;
  remove?(asset: ExternalAssetRef): void | Promise<void>;
}

export interface PresignedUploadPlan {
  asset: ExternalAssetRef;
  upload: {
    url: string;
    method?: "PUT" | "POST";
    headers?: Record<string, string>;
  };
}

export interface PresignedAttachmentAdapterOptions {
  prepareUpload(file: File, context: AgentAttachmentUploadContext): Promise<PresignedUploadPlan>;
  fetch?: FetchLike;
  accept?: string;
  maximumFiles?: number;
  maximumBytes?: number;
  remove?: (asset: ExternalAssetRef) => void | Promise<void>;
}

/** Uploads directly from the browser to a customer-owned presigned target. */
export function createPresignedAttachmentAdapter(
  options: PresignedAttachmentAdapterOptions,
): AgentAttachmentAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImplementation) throw new TypeError("A fetch implementation is required");
  const maximumBytes = options.maximumBytes ?? maximumAssetBytes;
  const maximumFiles = options.maximumFiles ?? 4;
  return Object.freeze({
    accept: options.accept ?? "image/jpeg,image/png,image/webp,image/gif",
    maximumFiles,
    maximumBytes,
    async upload(file: File, context: AgentAttachmentUploadContext) {
      validateFile(file, maximumBytes);
      const plan = await options.prepareUpload(file, context);
      validateAssetRef(plan.asset, file);
      const target = new URL(plan.upload.url);
      if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
        throw new TypeError("Presigned upload targets must use HTTPS outside local development");
      }
      const headers = new Headers(plan.upload.headers);
      if (!headers.has("Content-Type")) headers.set("Content-Type", file.type);
      const response = await fetchImplementation(target, {
        method: plan.upload.method ?? "PUT",
        headers,
        body: file,
        signal: context.signal,
      });
      if (!response.ok) {
        throw new Error(`Attachment upload failed with ${response.status}`);
      }
      return plan.asset;
    },
    ...(options.remove ? { remove: options.remove } : {}),
  });
}

export interface AttachmentResolverContext {
  operationId: string;
  tenantId: string;
  environmentId: string;
  agentRevisionId: string;
  asset: ExternalAssetRef;
  signal: AbortSignal;
}

export interface AttachmentResolverHandlerOptions {
  endpoint: string;
  handlerRevision: string;
  resolve(context: AttachmentResolverContext): Blob | ArrayBuffer | Uint8Array | Promise<Blob | ArrayBuffer | Uint8Array>;
  issuer?: string;
  jwksUrl?: string;
  jwks?: JSONWebKeySet;
}

/** Verifies a signed runtime request before reading a customer-owned asset. */
export function createAttachmentResolverHandler(
  options: AttachmentResolverHandlerOptions,
): (request: Request) => Promise<Response> {
  const endpoint = normalizeEndpoint(options.endpoint);
  const issuer = normalizeIssuer(options.issuer ?? defaultIssuer);
  if (options.jwks && options.jwksUrl) throw new TypeError("Provide either jwks or jwksUrl, not both");
  const key: JWTVerifyGetKey = options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(options.jwksUrl ?? defaultJwksUrl));

  return async (request) => {
    if (request.method !== "POST") return jsonError(405, "method_not_allowed", "Use POST");
    if (normalizeEndpoint(request.url) !== endpoint) return jsonError(404, "asset_endpoint_mismatch", "Asset endpoint does not match");
    if (request.headers.get("CodeSpring-Agent-Asset-Version") !== "1") {
      return jsonError(400, "unsupported_asset_protocol", "Asset protocol version is unsupported");
    }
    const token = request.headers.get("CodeSpring-Agent-Asset-JWT");
    if (!token) return jsonError(401, "missing_asset_authorization", "Asset authorization is required");
    let body: string;
    let invocation: ReturnType<typeof parseInvocation>;
    try {
      body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 16 * 1_024) throw new Error("too large");
      invocation = parseInvocation(JSON.parse(body));
    } catch {
      return jsonError(400, "invalid_asset_invocation", "Asset invocation is invalid");
    }
    if (invocation.handlerRevision !== options.handlerRevision) {
      return jsonError(409, "asset_handler_revision_unavailable", "The pinned asset handler revision is unavailable");
    }
    try {
      const verified = await jwtVerify(token, key, {
        issuer,
        audience: endpoint,
        algorithms: ["ES256"],
        typ: "codespring-agent-asset+jwt",
      });
      const claims = verified.payload;
      if (
        claims.body_sha256 !== await sha256Base64Url(body) ||
        claims.jti !== invocation.operationId ||
        claims.sub !== `${invocation.tenantId}:${invocation.environmentId}` ||
        claims.operation_id !== invocation.operationId ||
        claims.tenant_id !== invocation.tenantId ||
        claims.environment_id !== invocation.environmentId ||
        claims.agent_revision_id !== invocation.agentRevisionId ||
        claims.handler_revision !== invocation.handlerRevision
      ) throw new Error("claims mismatch");
    } catch {
      return jsonError(401, "invalid_asset_authorization", "Asset authorization is invalid");
    }
    try {
      const resolved = await options.resolve({
        operationId: invocation.operationId,
        tenantId: invocation.tenantId,
        environmentId: invocation.environmentId,
        agentRevisionId: invocation.agentRevisionId,
        asset: invocation.asset,
        signal: request.signal,
      });
      const bytes = await toArrayBuffer(resolved);
      if (bytes.byteLength !== invocation.asset.sizeBytes || bytes.byteLength > maximumAssetBytes) {
        return jsonError(409, "asset_size_mismatch", "Resolved asset size does not match its reference");
      }
      if (invocation.asset.sha256 && await sha256Hex(bytes) !== invocation.asset.sha256) {
        return jsonError(409, "asset_digest_mismatch", "Resolved asset failed integrity validation");
      }
      return new Response(bytes, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": invocation.asset.mediaType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return jsonError(503, "asset_resolution_failed", "Asset resolution failed");
    }
  };
}

function validateFile(file: File, maximumBytes: number): void {
  if (!supportedTypes.has(file.type)) throw new TypeError("Unsupported attachment type");
  if (file.size < 1 || file.size > maximumBytes) throw new TypeError("Attachment size is outside the configured limit");
}

function validateAssetRef(asset: ExternalAssetRef, file: File): void {
  if (asset.kind !== "external" || !asset.assetId.trim() || asset.assetId.length > 512) throw new TypeError("Upload plan returned an invalid asset reference");
  if (asset.mediaType !== file.type || asset.sizeBytes !== file.size) throw new TypeError("Upload plan metadata does not match the selected file");
  if (asset.sha256 && !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new TypeError("Upload plan returned an invalid asset digest");
}

function parseInvocation(value: unknown): {
  schemaVersion: 1;
  operationId: string;
  tenantId: string;
  environmentId: string;
  agentRevisionId: string;
  handlerRevision: string;
  asset: ExternalAssetRef;
} {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.asset)) throw new Error("invalid invocation");
  const fields = ["operationId", "tenantId", "environmentId", "agentRevisionId", "handlerRevision"] as const;
  for (const field of fields) if (typeof value[field] !== "string" || !value[field].trim()) throw new Error("invalid invocation");
  const asset = value.asset;
  if (
    asset.kind !== "external" ||
    typeof asset.assetId !== "string" || !asset.assetId.trim() || asset.assetId.length > 512 ||
    typeof asset.mediaType !== "string" || !supportedTypes.has(asset.mediaType) ||
    typeof asset.sizeBytes !== "number" || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > maximumAssetBytes ||
    (asset.sha256 !== undefined && (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)))
  ) throw new Error("invalid asset");
  return value as ReturnType<typeof parseInvocation>;
}

async function toArrayBuffer(value: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (value instanceof Blob) return value.arrayBuffer();
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function normalizeIssuer(value: string): string {
  return new URL(value).toString().replace(/\/$/u, "");
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import {
  AppBridge,
  buildAllowAttribute,
  McpUiResourceCspSchema,
  McpUiResourcePermissionsSchema,
  PostMessageTransport,
  type McpUiDisplayMode,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentSession } from "./client";

export interface McpAppDescriptor {
  resourceUri: `ui://${string}`;
  serverId?: string;
  snapshotId?: string;
  resourceDigest?: string;
}

export interface McpAppResource {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

export interface McpAppToolContext {
  descriptor: McpAppDescriptor;
  toolName: string;
  input?: unknown;
  output?: unknown;
}

export type McpAppToolResult = CallToolResult;

export interface McpAppsHostPolicy {
  loadResource(context: McpAppToolContext, signal: AbortSignal): Promise<McpAppResource>;
  callTool?(
    context: McpAppToolContext,
    request: { name: string; arguments?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<McpAppToolResult>;
  sendMessage?(
    context: McpAppToolContext,
    message: { role: "user"; content: ContentBlock[] },
    signal: AbortSignal,
  ): Promise<void>;
  openLink?(context: McpAppToolContext, url: string): Promise<boolean> | boolean;
  onDisplayModeChange?(
    context: McpAppToolContext,
    requested: McpUiDisplayMode,
  ): Promise<McpUiDisplayMode> | McpUiDisplayMode;
}

export interface CreateMcpAppsHostOptions extends McpAppsHostPolicy {
  /** URL of a dedicated, cross-origin MCP Apps sandbox proxy. */
  sandboxUrl: string;
  hostName?: string;
  hostVersion?: string;
  maxHeight?: number;
}

export interface McpAppsHost extends McpAppsHostPolicy {
  readonly sandboxUrl: string;
  readonly hostName: string;
  readonly hostVersion: string;
  readonly maxHeight: number;
}

export function createMcpAppsHost(options: CreateMcpAppsHostOptions): McpAppsHost {
  const sandbox = new URL(options.sandboxUrl);
  if (sandbox.protocol !== "https:" && sandbox.hostname !== "localhost" && sandbox.hostname !== "127.0.0.1") {
    throw new TypeError("MCP Apps sandbox URL must use HTTPS");
  }
  if (typeof window !== "undefined" && sandbox.origin === window.location.origin) {
    throw new TypeError("MCP Apps sandbox must use a different origin from its host");
  }
  return Object.freeze({
    sandboxUrl: sandbox.toString(),
    hostName: options.hostName ?? "CodeSpring Agents host",
    hostVersion: options.hostVersion ?? "1.0.0",
    maxHeight: Math.max(240, Math.min(options.maxHeight ?? 720, 2_000)),
    loadResource: options.loadResource,
    ...(options.callTool ? { callTool: options.callTool } : {}),
    ...(options.sendMessage ? { sendMessage: options.sendMessage } : {}),
    ...(options.openLink ? { openLink: options.openLink } : {}),
    ...(options.onDisplayModeChange ? { onDisplayModeChange: options.onDisplayModeChange } : {}),
  });
}

export interface CreateSessionMcpAppsHostOptions
  extends Omit<CreateMcpAppsHostOptions, "loadResource" | "callTool"> {
  session: AgentSession;
  allowAppToolCalls?: boolean;
}

/** Creates a host backed by the runtime's session-scoped MCP Apps boundary. */
export function createSessionMcpAppsHost(
  options: CreateSessionMcpAppsHostOptions,
): McpAppsHost {
  const { session, allowAppToolCalls = true, ...host } = options;
  return createMcpAppsHost({
    ...host,
    async loadResource(context, signal) {
      const target = requirePinnedDescriptor(context.descriptor);
      const resource = await session.readMcpAppResource({
        serverId: target.serverId,
        snapshotId: target.snapshotId,
        resourceUri: target.resourceUri,
      }, { signal });
      return {
        html: resource.html,
        ...(resource.csp ? { csp: resource.csp as McpUiResourceCsp } : {}),
        ...(resource.permissions
          ? { permissions: resource.permissions as McpUiResourcePermissions }
          : {}),
      };
    },
    ...(allowAppToolCalls ? {
      callTool: async (context: McpAppToolContext, request: {
        name: string;
        arguments?: Record<string, unknown>;
      }, signal: AbortSignal) => {
        const target = requirePinnedDescriptor(context.descriptor);
        return normalizeToolResult(await session.callMcpAppTool({
          serverId: target.serverId,
          snapshotId: target.snapshotId,
          resourceUri: target.resourceUri,
          toolName: request.name,
          arguments: request.arguments ?? {},
        }, { signal }));
      },
    } : {}),
  });
}

export function getMcpAppDescriptor(output: unknown): McpAppDescriptor | null {
  if (!isRecord(output)) return null;
  const direct = isRecord(output.mcpApp) ? output.mcpApp : null;
  const meta = isRecord(output._meta) ? output._meta : null;
  const ui = meta && isRecord(meta.ui) ? meta.ui : null;
  const source = direct ?? ui;
  const resourceUri = source?.resourceUri;
  if (typeof resourceUri !== "string" || !resourceUri.startsWith("ui://") || resourceUri.length > 2_048) {
    return null;
  }
  if (!source) return null;
  return {
    resourceUri: resourceUri as `ui://${string}`,
    ...(typeof source.serverId === "string" ? { serverId: source.serverId } : {}),
    ...(typeof source.snapshotId === "string" ? { snapshotId: source.snapshotId } : {}),
    ...(typeof source.resourceDigest === "string" ? { resourceDigest: source.resourceDigest } : {}),
  };
}

export interface McpAppProps {
  host: McpAppsHost;
  descriptor: McpAppDescriptor;
  toolName: string;
  input?: unknown;
  output?: unknown;
  className?: string;
  style?: CSSProperties;
  loadingFallback?: ReactNode;
  errorFallback?: (error: Error, retry: () => void) => ReactNode;
}

export function createMcpAppSandboxUrl(
  sandboxUrl: string,
  hostOrigin: string,
  resource: Pick<McpAppResource, "csp" | "permissions">,
): string {
  const url = new URL(sandboxUrl);
  url.searchParams.set("hostOrigin", hostOrigin);
  if (resource.csp) url.searchParams.set("csp", JSON.stringify(resource.csp));
  if (resource.permissions) url.searchParams.set("permissions", JSON.stringify(resource.permissions));
  if (url.toString().length > 16_384) {
    throw new TypeError("MCP App sandbox policy is too large");
  }
  return url.toString();
}

export function McpApp({
  host,
  descriptor,
  toolName,
  input,
  output,
  className,
  style,
  loadingFallback = "Loading app…",
  errorFallback,
}: McpAppProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState<Error | null>(null);
  const [resource, setResource] = useState<McpAppResource | null>(null);
  const [sandboxDocumentUrl, setSandboxDocumentUrl] = useState<string | null>(null);
  const context = useMemo<McpAppToolContext>(() => ({
    descriptor,
    toolName,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  }), [descriptor, input, output, toolName]);

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setReady(false);
    setError(null);
    setResource(null);
    setSandboxDocumentUrl(null);
    void host.loadResource(context, abort.signal).then((loaded) => {
      if (!active) return;
      if (loaded.csp !== undefined) McpUiResourceCspSchema.parse(loaded.csp);
      if (loaded.permissions !== undefined) McpUiResourcePermissionsSchema.parse(loaded.permissions);
      if (typeof window === "undefined") throw new TypeError("MCP Apps require a browser host");
      const sandboxUrl = createMcpAppSandboxUrl(host.sandboxUrl, window.location.origin, loaded);
      setResource(loaded);
      setSandboxDocumentUrl(sandboxUrl);
    }).catch((reason) => {
      if (active && !abort.signal.aborted) setError(normalizeError(reason));
    });
    return () => {
      active = false;
      abort.abort();
    };
  }, [context, host, loadKey]);

  useEffect(() => {
    if (!resource || !sandboxDocumentUrl) return;
    const element = iframe.current;
    const frameWindow = element?.contentWindow;
    if (!element || !frameWindow) return;

    const abort = new AbortController();
    let active = true;
    const bridge = new AppBridge(
      null,
      { name: host.hostName, version: host.hostVersion },
      {
        sandbox: {},
        ...(host.callTool ? { serverTools: {} } : {}),
        ...(host.sendMessage ? { message: { text: {} } } : {}),
        ...(host.openLink ? { openLinks: {} } : {}),
      },
      {
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { maxHeight: host.maxHeight },
          locale: typeof navigator === "undefined" ? "en" : navigator.language,
          platform: "web",
        },
      },
    );

    bridge.addEventListener("sandboxready", () => {
      void (async () => {
        try {
          if (!active) return;
          await bridge.sendSandboxResourceReady({
            html: resource.html,
            sandbox: "allow-scripts allow-same-origin allow-forms",
            ...(resource.csp ? { csp: resource.csp } : {}),
            ...(resource.permissions ? { permissions: resource.permissions } : {}),
          });
        } catch (reason) {
          if (active && !abort.signal.aborted) setError(normalizeError(reason));
        }
      })();
    });
    bridge.addEventListener("initialized", () => {
      void (async () => {
        try {
          const argumentsValue = isRecord(input) ? input : {};
          await bridge.sendToolInput({ arguments: argumentsValue });
          await bridge.sendToolResult(normalizeToolResult(output));
          if (active) setReady(true);
        } catch (reason) {
          if (active && !abort.signal.aborted) setError(normalizeError(reason));
        }
      })();
    });
    bridge.addEventListener("sizechange", ({ height: nextHeight }) => {
      if (typeof nextHeight === "number" && Number.isFinite(nextHeight)) {
        setHeight(Math.max(120, Math.min(Math.ceil(nextHeight), host.maxHeight)));
      }
    });
    bridge.oncalltool = host.callTool
      ? async (request, extra) => host.callTool!(context, {
        name: request.name,
        ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
      }, extra.signal)
      : undefined;
    bridge.onmessage = host.sendMessage
      ? async (message, extra) => {
        await host.sendMessage!(context, message, extra.signal);
        return {};
      }
      : undefined;
    bridge.onopenlink = host.openLink
      ? async ({ url }) => ({ isError: !(await host.openLink!(context, url)) })
      : undefined;
    bridge.onrequestdisplaymode = async ({ mode }) => ({
      mode: host.onDisplayModeChange
        ? await host.onDisplayModeChange(context, mode)
        : "inline",
    });

    setReady(false);
    setError(null);
    void bridge.connect(new PostMessageTransport(frameWindow, frameWindow)).catch((reason) => {
      if (active && !abort.signal.aborted) setError(normalizeError(reason));
    });
    element.src = sandboxDocumentUrl;

    return () => {
      active = false;
      abort.abort();
      void bridge.teardownResource({}, { timeout: 500 }).catch(() => undefined).finally(() => bridge.close());
    };
  }, [context, host, input, output, resource, sandboxDocumentUrl]);

  if (error) {
    const retry = () => setLoadKey((value) => value + 1);
    return <div className={className} role="alert" style={style}>
      {errorFallback ? errorFallback(error, retry) : (
        <div style={{ padding: 14, border: "1px solid currentColor", borderRadius: 8 }}>
          <div>This app could not be loaded.</div>
          <button type="button" onClick={retry} style={{ marginTop: 8 }}>Retry</button>
        </div>
      )}
    </div>;
  }

  return <div className={className} style={{ position: "relative", minHeight: ready ? undefined : 120, ...style }}>
    {!ready ? <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{loadingFallback}</div> : null}
    {resource && sandboxDocumentUrl ? <iframe
      key={loadKey}
      ref={iframe}
      title={`${toolName} app`}
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow={buildAllowAttribute(resource.permissions)}
      referrerPolicy="origin"
      style={{ width: "100%", height, border: 0, display: "block", visibility: ready ? "visible" : "hidden" }}
    /> : null}
  </div>;
}

function normalizeToolResult(output: unknown): McpAppToolResult {
  if (!isRecord(output)) return { content: [] };
  const content = Array.isArray(output.content) ? output.content as ContentBlock[] : [];
  return {
    content,
    ...(isRecord(output.structuredContent) ? { structuredContent: output.structuredContent } : {}),
    ...(typeof output.isError === "boolean" ? { isError: output.isError } : {}),
    ...(isRecord(output._meta) ? { _meta: output._meta } : {}),
  };
}

function requirePinnedDescriptor(descriptor: McpAppDescriptor): Required<
  Pick<McpAppDescriptor, "resourceUri" | "serverId" | "snapshotId">
> {
  if (!descriptor.serverId || !descriptor.snapshotId) {
    throw new TypeError("MCP App descriptor is missing its pinned server snapshot");
  }
  return {
    resourceUri: descriptor.resourceUri,
    serverId: descriptor.serverId,
    snapshotId: descriptor.snapshotId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

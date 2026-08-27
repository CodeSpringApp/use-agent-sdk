import {
  createContext,
  createElement,
  type CSSProperties,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createBrowserClient, type AgentClient, type AgentSession } from "./client";
import type {
  AgentEvent,
  BrowserAgentClientOptions,
  SessionSnapshot,
  SubmitOptions,
  SubmitTurnResponse,
} from "./types";

export interface AgentTheme {
  canvas: string;
  ink: string;
  inkSecondary: string;
  inkTertiary: string;
  well: string;
  hairline: string;
  statusGood: string;
  statusBad: string;
  statusWarn: string;
  accent: string;
  fontFamily: string;
  monoFamily: string;
  contentMaxWidth: number;
  containerRadius: number;
  wellRadius: number;
}

export interface AgentCopy {
  title: string;
  empty: string;
  loading: string;
  thinking: string;
  placeholder: string;
  send: string;
  sending: string;
  failed: string;
  cancelled: string;
  userLabel: string;
  assistantLabel: string;
  toolRunning: string;
  toolCompleted: string;
  toolFailed: string;
  toolApprovalRequired: string;
}

export const paperLightTheme: Readonly<AgentTheme> = Object.freeze({
  canvas: "#FFFFFF",
  ink: "#141414",
  inkSecondary: "#68686D",
  inkTertiary: "#9B9BA0",
  well: "#F5F5F8",
  hairline: "#E4E4E8",
  statusGood: "#0E7B3F",
  statusBad: "#C33530",
  statusWarn: "#A06C02",
  accent: "#3B6AC5",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  monoFamily: "SFMono-Regular, SF Mono, ui-monospace, Menlo, Consolas, monospace",
  contentMaxWidth: 760,
  containerRadius: 10,
  wellRadius: 8,
});

export const paperDarkTheme: Readonly<AgentTheme> = Object.freeze({
  ...paperLightTheme,
  canvas: "#161618",
  ink: "#ECECEC",
  inkSecondary: "#98989D",
  inkTertiary: "#66666B",
  well: "#1D1D1F",
  hairline: "#29292C",
  statusGood: "#63C180",
  statusBad: "#DF5048",
  statusWarn: "#E3A648",
  accent: "#87B1FD",
});

export const defaultAgentCopy: Readonly<AgentCopy> = Object.freeze({
  title: "Assistant",
  empty: "Start a conversation",
  loading: "Loading conversation…",
  thinking: "Working…",
  placeholder: "Message the agent — Shift+Enter for a new line",
  send: "Send message",
  sending: "Sending…",
  failed: "The agent could not complete this message.",
  cancelled: "This message was cancelled.",
  userLabel: "You",
  assistantLabel: "Assistant",
  toolRunning: "Running",
  toolCompleted: "Completed",
  toolFailed: "Failed",
  toolApprovalRequired: "Approval required",
});

export interface AgentAppearance {
  readonly theme: Readonly<AgentTheme>;
  readonly copy: Readonly<AgentCopy>;
}

export interface CreateAgentAppearanceOptions {
  mode?: "light" | "dark";
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function createAgentAppearance({
  mode = "light",
  theme,
  copy,
}: CreateAgentAppearanceOptions = {}): AgentAppearance {
  return Object.freeze({
    theme: Object.freeze({ ...(mode === "dark" ? paperDarkTheme : paperLightTheme), ...theme }),
    copy: Object.freeze({ ...defaultAgentCopy, ...copy }),
  });
}

export const paperAppearance = createAgentAppearance();
export const paperDarkAppearance = createAgentAppearance({ mode: "dark" });

interface AgentContextValue {
  client: AgentClient;
  theme: AgentTheme;
  copy: AgentCopy;
  stores: Map<string, SessionStore>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export interface AgentProviderProps extends PropsWithChildren {
  client: AgentClient;
  appearance?: AgentAppearance;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

function shallowEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function useStablePartial<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  const stable = useRef(value);
  if (!shallowEqual(stable.current ?? {}, value ?? {})) stable.current = value;
  return stable.current;
}

export function AgentProvider({
  client,
  appearance = paperAppearance,
  theme,
  copy,
  children,
}: AgentProviderProps) {
  const stableTheme = useStablePartial(theme);
  const stableCopy = useStablePartial(copy);
  const resolvedTheme = useMemo(
    () => Object.freeze({ ...appearance.theme, ...stableTheme }),
    [appearance.theme, stableTheme],
  );
  const resolvedCopy = useMemo(
    () => Object.freeze({ ...appearance.copy, ...stableCopy }),
    [appearance.copy, stableCopy],
  );
  const stores = useMemo(() => new Map<string, SessionStore>(), [client]);
  useEffect(() => () => {
    for (const store of stores.values()) store.dispose();
    stores.clear();
  }, [stores]);
  const value = useMemo(
    () => ({
      client,
      theme: resolvedTheme,
      copy: resolvedCopy,
      stores,
    }),
    [client, resolvedTheme, resolvedCopy, stores],
  );
  return createElement(AgentContext.Provider, { value }, children);
}

function useAgentContext(): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) throw new Error("Agent React APIs must be used inside AgentProvider");
  return value;
}

export function useAgentClient(): AgentClient {
  return useAgentContext().client;
}

export interface UseAgentConnectionOptions {
  endpoint: string;
  clientTokenEndpoint: string;
  fetch?: BrowserAgentClientOptions["fetch"];
  credentials?: RequestCredentials;
  clientTokenTtlMs?: number;
  refreshSkewMs?: number;
}

/** Creates one browser client and owns its in-memory, deduplicated client-token cache. */
export function useAgentConnection({
  endpoint,
  clientTokenEndpoint,
  fetch: fetchImplementation,
  credentials = "same-origin",
  clientTokenTtlMs,
  refreshSkewMs,
}: UseAgentConnectionOptions): AgentClient {
  return useMemo(
    () =>
      createBrowserClient({
        endpoint,
        getClientToken: async () => {
          const request = fetchImplementation ?? globalThis.fetch;
          if (!request) throw new TypeError("A fetch implementation is required");
          const response = await request(clientTokenEndpoint, {
            method: "POST",
            credentials,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(`Client token request failed with ${response.status}`);
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json")) return response.text();
          const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
          if (typeof body.token !== "string") throw new Error("Client token response is missing token");
          return {
            token: body.token,
            ...(typeof body.expiresAt === "string" || typeof body.expiresAt === "number"
              ? { expiresAt: body.expiresAt }
              : {}),
          };
        },
        ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
        ...(clientTokenTtlMs === undefined ? {} : { clientTokenTtlMs }),
        ...(refreshSkewMs === undefined ? {} : { refreshSkewMs }),
      }),
    [
      endpoint,
      clientTokenEndpoint,
      fetchImplementation,
      credentials,
      clientTokenTtlMs,
      refreshSkewMs,
    ],
  );
}

export function useAgentTheme(): AgentTheme {
  return useAgentContext().theme;
}

export function useAgentCopy(): AgentCopy {
  return useAgentContext().copy;
}

export type AgentMessageStatus = "completed" | "streaming" | "failed" | "cancelled";

export interface AgentChatMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  status: AgentMessageStatus;
  createdAt: string;
  eventId: number;
}

export type AgentToolCallStatus =
  | "proposed"
  | "running"
  | "completed"
  | "failed"
  | "approval_required";

export interface AgentToolCall {
  id: string;
  turnId: string;
  name: string;
  label: string;
  summary?: string;
  status: AgentToolCallStatus;
  input?: unknown;
  output?: unknown;
  createdAt: string;
  eventId: number;
}

function stringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function unknownField(data: unknown, key: string): unknown {
  if (!data || typeof data !== "object") return undefined;
  return (data as Record<string, unknown>)[key];
}

/** Pure reducer for consumers that want CodeSpring's durable event semantics with custom UI. */
export function reduceAgentMessages(events: readonly AgentEvent[]): AgentChatMessage[] {
  const messages = new Map<string, AgentChatMessage>();

  for (const event of events) {
    if (!event.turnId) continue;
    const inputId = `${event.turnId}:user`;
    const outputId = `${event.turnId}:assistant:${event.attempt}`;

    if (event.type === "message.input") {
      messages.set(inputId, {
        id: inputId,
        turnId: event.turnId,
        role: "user",
        content: stringField(event.data, "content") ?? "",
        status: "completed",
        createdAt: event.createdAt,
        eventId: event.id,
      });
      continue;
    }

    if (event.type === "message.started") {
      messages.set(outputId, {
        id: outputId,
        turnId: event.turnId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: event.createdAt,
        eventId: event.id,
      });
      continue;
    }

    if (event.type === "message.delta") {
      const current = messages.get(outputId);
      if (current) {
        messages.set(outputId, {
          ...current,
          content: current.content + (stringField(event.data, "delta") ?? ""),
          eventId: event.id,
        });
      }
      continue;
    }

    if (event.type === "message.completed") {
      const current = messages.get(outputId);
      messages.set(outputId, {
        id: outputId,
        turnId: event.turnId,
        role: "assistant",
        content: stringField(event.data, "content") ?? current?.content ?? "",
        status: "completed",
        createdAt: current?.createdAt ?? event.createdAt,
        eventId: event.id,
      });
      continue;
    }

    if (event.type === "message.attempt_abandoned") {
      messages.delete(outputId);
      continue;
    }

    if (event.type === "turn.failed" || event.type === "turn.cancelled") {
      const current = [...messages.values()]
        .filter((message) => message.turnId === event.turnId && message.role === "assistant")
        .at(-1);
      const terminalId = current?.id ?? `${event.turnId}:assistant:${event.attempt}`;
      messages.set(terminalId, {
        id: terminalId,
        turnId: event.turnId,
        role: "assistant",
        content: current?.content ?? "",
        status: event.type === "turn.failed" ? "failed" : "cancelled",
        createdAt: current?.createdAt ?? event.createdAt,
        eventId: event.id,
      });
    }
  }

  return [...messages.values()].sort((left, right) => left.eventId - right.eventId);
}

/** Pure reducer for durable server, MCP, and client tool activity. */
export function reduceAgentToolCalls(events: readonly AgentEvent[]): AgentToolCall[] {
  const calls = new Map<string, AgentToolCall>();

  for (const event of events) {
    if (!event.turnId || !event.type.startsWith("tool.call.")) continue;
    const eventName = stringField(event.data, "name");
    const callId = stringField(event.data, "toolCallId") ?? `${event.turnId}:${event.attempt}:${eventName ?? "tool"}`;
    const current = calls.get(callId);
    const name = eventName ?? current?.name ?? "tool";
    const summary = stringField(event.data, "summary");
    const status: AgentToolCallStatus =
      event.type === "tool.call.completed"
        ? "completed"
        : event.type === "tool.call.failed"
          ? "failed"
          : event.type === "tool.call.approval_required"
            ? "approval_required"
            : event.type === "tool.call.started"
              ? "running"
              : "proposed";

    calls.set(callId, {
      id: callId,
      turnId: event.turnId,
      name,
      label: stringField(event.data, "label") ?? current?.label ?? name,
      ...(summary === undefined
        ? current?.summary === undefined
          ? {}
          : { summary: current.summary }
        : { summary }),
      status,
      ...(unknownField(event.data, "input") === undefined
        ? current?.input === undefined
          ? {}
          : { input: current.input }
        : { input: unknownField(event.data, "input") }),
      ...(unknownField(event.data, "output") === undefined
        ? current?.output === undefined
          ? {}
          : { output: current.output }
        : { output: unknownField(event.data, "output") }),
      createdAt: current?.createdAt ?? event.createdAt,
      eventId: event.id,
    });
  }

  return [...calls.values()].sort((left, right) => left.eventId - right.eventId);
}

interface SessionState {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: SessionSnapshot | null;
  events: AgentEvent[];
  messages: AgentChatMessage[];
  toolCalls: AgentToolCall[];
  error: Error | null;
}

const initialSessionState: SessionState = {
  status: "idle",
  snapshot: null,
  events: [],
  messages: [],
  toolCalls: [],
  error: null,
};

class SessionStore {
  private state: SessionState = initialSessionState;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly session: AgentSession) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.controller?.abort();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
    };
  };

  getSnapshot = () => this.state;
  getServerSnapshot = () => initialSessionState;

  private setState(state: SessionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const isWorking = this.state.snapshot?.turns.some(
      (turn) => turn.status === "queued" || turn.status === "running",
    );
    this.refreshTimer =
      isWorking && this.listeners.size > 0
        ? setTimeout(() => void this.refresh(), 1_000)
        : null;
  }

  async refresh() {
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.setState({
      ...this.state,
      status: this.state.snapshot ? "ready" : "loading",
      error: null,
    });
    try {
      const snapshot = await this.session.get({ signal });
      const events: AgentEvent[] = [];
      let cursor = 0;
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < 100) {
        const page = await this.session.events(cursor, 100, { signal });
        events.push(...page.events);
        cursor = page.cursor;
        hasMore = page.hasMore;
        pages += 1;
      }
      if (hasMore) throw new Error("Conversation history exceeds the current 10,000-event UI limit");
      this.setState({
        status: "ready",
        snapshot,
        events,
        messages: reduceAgentMessages(events),
        toolCalls: reduceAgentToolCalls(events),
        error: null,
      });
      this.scheduleRefresh();
    } catch (error) {
      if (signal.aborted) return;
      this.setState({
        ...this.state,
        status: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.scheduleRefresh();
    }
  }

  dispose() {
    this.controller?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}

export interface AgentSessionResult extends SessionState {
  session: AgentSession;
  refresh: () => Promise<void>;
  submit: (content: string, options?: SubmitOptions) => Promise<SubmitTurnResponse>;
  cancel: (turnId: string) => Promise<void>;
}

export function useAgentSession(sessionId: string): AgentSessionResult {
  const context = useAgentContext();
  const store = useMemo(() => {
    const existing = context.stores.get(sessionId);
    if (existing) return existing;
    const created = new SessionStore(context.client.sessions.get(sessionId));
    context.stores.set(sessionId, created);
    return created;
  }, [context.client, context.stores, sessionId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  return {
    ...state,
    session: store.session,
    refresh: () => store.refresh(),
    submit: async (content, options) => {
      const result = await store.session.submit(content, options);
      await store.refresh();
      return result;
    },
    cancel: async (turnId) => {
      await store.session.cancel(turnId);
      await store.refresh();
    },
  };
}

export function useAgentMessages(sessionId: string): AgentChatMessage[] {
  return useAgentSession(sessionId).messages;
}

export function useAgentToolCalls(sessionId: string): AgentToolCall[] {
  return useAgentSession(sessionId).toolCalls;
}

interface StyledProps {
  className?: string;
  style?: CSSProperties;
}

export interface AgentMessageProps extends StyledProps {
  message: AgentChatMessage;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

function inlineMarkdown(text: string, colors: AgentTheme): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`${index}:strong`} style={{ fontWeight: 650 }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={`${index}:code`}
          style={{
            padding: "1px 4px",
            borderRadius: 4,
            background: colors.well,
            fontFamily: colors.monoFamily,
            fontSize: 12,
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const parts = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/u.exec(token);
      nodes.push(
        <a
          key={`${index}:link`}
          href={parts?.[2]}
          target="_blank"
          rel="noreferrer"
          style={{ color: colors.accent, textDecorationThickness: 1, textUnderlineOffset: 2 }}
        >
          {parts?.[1]}
        </a>,
      );
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function AgentMarkdown({ content, colors }: { content: string; colors: AgentTheme }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div key={`code:${index}`} style={{ position: "relative", margin: "8px 0" }}>
          {language ? (
            <span
              style={{
                position: "absolute",
                top: 7,
                right: 9,
                color: colors.inkTertiary,
                fontFamily: colors.monoFamily,
                fontSize: 10,
              }}
            >
              {language}
            </span>
          ) : null}
          <pre
            style={{
              margin: 0,
              padding: language ? "25px 12px 11px" : "11px 12px",
              overflowX: "auto",
              borderRadius: colors.wellRadius,
              background: colors.well,
              fontFamily: colors.monoFamily,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <code>{code.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 3;
      blocks.push(
        <div
          key={`heading:${index}`}
          role="heading"
          aria-level={level}
          style={{
            margin: index === 0 ? "0 0 6px" : "14px 0 6px",
            fontSize: level === 1 ? 15 : 13,
            fontWeight: level < 3 ? 650 : 550,
            lineHeight: 1.35,
          }}
        >
          {inlineMarkdown(heading[2] ?? "", colors)}
        </div>,
      );
      index += 1;
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/u.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^[-*]\s+/u, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`list:${index}`} style={{ margin: "6px 0", paddingLeft: 19 }}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex} style={{ margin: "3px 0", paddingLeft: 2 }}>
              {inlineMarkdown(item, colors)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quote.push((lines[index] ?? "").slice(2));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`quote:${index}`}
          style={{
            margin: "8px 0",
            paddingLeft: 10,
            borderLeft: `2px solid ${colors.hairline}`,
            color: colors.inkSecondary,
          }}
        >
          {inlineMarkdown(quote.join("\n"), colors)}
        </blockquote>,
      );
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^(#{1,3})\s+|^```|^[-*]\s+|^> /u.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(
      <p key={`paragraph:${index}`} style={{ margin: "0 0 9px", whiteSpace: "pre-wrap" }}>
        {inlineMarkdown(paragraph.join("\n"), colors)}
      </p>,
    );
  }
  return <>{blocks}</>;
}

export function AgentMessage({ message, className, style, theme, copy }: AgentMessageProps) {
  const context = useAgentContext();
  const colors = { ...context.theme, ...theme };
  const labels = { ...context.copy, ...copy };
  const isUser = message.role === "user";
  const fallback =
    message.status === "failed"
      ? labels.failed
      : message.status === "cancelled"
        ? labels.cancelled
        : labels.thinking;

  return (
    <article
      className={className}
      aria-label={isUser ? labels.userLabel : labels.assistantLabel}
      style={{
        alignSelf: isUser ? "flex-end" : "stretch",
        maxWidth: isUser ? "min(82%, 620px)" : "100%",
        color: message.status === "failed" ? colors.statusBad : colors.ink,
        background: isUser ? colors.well : "transparent",
        borderRadius: isUser ? colors.containerRadius : 0,
        padding: isUser ? "8px 12px" : 0,
        fontSize: 13,
        lineHeight: 1.52,
        whiteSpace: isUser ? "pre-wrap" : "normal",
        overflowWrap: "anywhere",
        ...style,
      }}
    >
      {message.content ? (isUser ? message.content : <AgentMarkdown content={message.content} colors={colors} />) : fallback}
    </article>
  );
}

export interface AgentToolCallProps extends StyledProps {
  toolCall: AgentToolCall;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

function formatToolPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function humanizeToolName(name: string): string {
  const action = name.split(/[./:]/u).at(-1) ?? name;
  const words = action.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Use tool";
}

function deriveToolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entry = Object.entries(input as Record<string, unknown>).find(
    ([, value]) => typeof value === "string" || typeof value === "number",
  );
  if (!entry) return undefined;
  const value = String(entry[1]);
  return value.length > 42 ? `${value.slice(0, 39)}…` : value;
}

function ToolActionGlyph({ name, color }: { name: string; color: string }) {
  const normalized = name.toLowerCase();
  if (normalized.includes("search") || normalized.includes("lookup") || normalized.includes("find")) {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="5" cy="5" r="3.25" stroke={color} strokeWidth="1.2" />
        <path d="m7.5 7.5 2.3 2.3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (normalized.includes("read") || normalized.includes("file") || normalized.includes("document")) {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 1.5h4l2 2V10.5H3z" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M7 1.8V4h2.1" stroke={color} strokeWidth="1.1" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.2 2.2 2.1 6l2.1 3.8M7.8 2.2 9.9 6 7.8 9.8" stroke={color} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusGlyph({ status, colors }: { status: AgentToolCallStatus; colors: AgentTheme }) {
  if (status === "completed") {
    return <span aria-hidden="true" style={{ color: colors.statusGood, fontSize: 12 }}>✓</span>;
  }
  if (status === "failed") {
    return <span aria-hidden="true" style={{ color: colors.statusBad, fontSize: 13 }}>×</span>;
  }
  if (status === "approval_required") {
    return <span aria-hidden="true" style={{ color: colors.statusWarn, fontSize: 11 }}>?</span>;
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        border: `1.5px solid ${colors.hairline}`,
        borderTopColor: colors.inkSecondary,
        borderRadius: "50%",
      }}
    />
  );
}

export function AgentToolCall({ toolCall, className, style, theme, copy }: AgentToolCallProps) {
  const context = useAgentContext();
  const colors = { ...context.theme, ...theme };
  const labels = { ...context.copy, ...copy };
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hasDetails = toolCall.input !== undefined || toolCall.output !== undefined;
  const title = toolCall.label === toolCall.name ? humanizeToolName(toolCall.name) : toolCall.label;
  const summary = toolCall.summary ?? deriveToolSummary(toolCall.input);
  const statusLabel =
    toolCall.status === "completed"
      ? labels.toolCompleted
      : toolCall.status === "failed"
        ? labels.toolFailed
        : toolCall.status === "approval_required"
          ? labels.toolApprovalRequired
          : labels.toolRunning;

  return (
    <div className={className} style={{ color: colors.inkSecondary, ...style }}>
      <button
        type="button"
        aria-expanded={hasDetails ? expanded : undefined}
        aria-label={`${title}: ${statusLabel}`}
        disabled={!hasDetails}
        onClick={() => hasDetails && setExpanded((current) => !current)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          display: "flex",
          width: "100%",
          minHeight: 28,
          alignItems: "center",
          gap: 7,
          padding: "0 4px",
          border: 0,
          borderRadius: 6,
          color: "inherit",
          background: hovered ? colors.well : "transparent",
          cursor: hasDetails ? "pointer" : "default",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ display: "grid", width: 12, placeItems: "center", flex: "0 0 12px" }}>
          {hovered && hasDetails ? (
            <span style={{ fontSize: 14, lineHeight: 1, transform: expanded ? "rotate(90deg)" : undefined }}>›</span>
          ) : (
            <ToolActionGlyph name={toolCall.name} color={colors.inkSecondary} />
          )}
        </span>
        <span style={{ fontSize: 11, fontWeight: 550, lineHeight: 1.2 }}>{title}</span>
        {summary ? (
          <span
            style={{
              minWidth: 0,
              maxWidth: "55%",
              overflow: "hidden",
              padding: "3px 6px",
              borderRadius: 5,
              background: colors.well,
              color: colors.inkSecondary,
              fontSize: 11,
              lineHeight: 1,
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ display: "grid", width: 16, minHeight: 24, placeItems: "center" }}>
          <StatusGlyph status={toolCall.status} colors={colors} />
        </span>
      </button>
      {expanded && hasDetails ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            margin: "3px 0 7px 9px",
            padding: "3px 0 3px 14px",
            borderLeft: `1px solid ${colors.hairline}`,
            color: colors.inkSecondary,
            fontFamily: colors.monoFamily,
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {toolCall.input !== undefined ? (
            <div>
              <div style={{ marginBottom: 2, color: colors.inkTertiary, fontFamily: colors.fontFamily }}>Input</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>
                {formatToolPayload(toolCall.input)}
              </pre>
            </div>
          ) : null}
          {toolCall.output !== undefined ? (
            <div>
              <div style={{ marginBottom: 2, color: colors.inkTertiary, fontFamily: colors.fontFamily }}>Output</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>
                {formatToolPayload(toolCall.output)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface AgentMessageListProps extends StyledProps {
  messages: readonly AgentChatMessage[];
  toolCalls?: readonly AgentToolCall[];
  isWorking?: boolean;
  renderMessage?: (message: AgentChatMessage) => ReactNode;
  renderToolCall?: (toolCall: AgentToolCall) => ReactNode;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentMessageList({
  messages,
  toolCalls = [],
  isWorking = false,
  renderMessage,
  renderToolCall,
  className,
  style,
  theme,
  copy,
}: AgentMessageListProps) {
  const context = useAgentContext();
  const colors = { ...context.theme, ...theme };
  const labels = { ...context.copy, ...copy };
  const end = useRef<HTMLDivElement>(null);
  const scrollSurface = useRef<HTMLDivElement>(null);
  const atLiveEdge = useRef(true);
  const transcript = [
    ...messages.map((message) => ({ type: "message" as const, item: message })),
    ...toolCalls.map((toolCall) => ({ type: "tool" as const, item: toolCall })),
  ].sort((left, right) => left.item.eventId - right.item.eventId);

  useEffect(() => {
    if (atLiveEdge.current) end.current?.scrollIntoView({ block: "end" });
  }, [messages, toolCalls, isWorking]);

  return (
    <div
      className={className}
      aria-live="polite"
      ref={scrollSurface}
      onScroll={() => {
        const element = scrollSurface.current;
        if (element) atLiveEdge.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      style={{
        display: "flex",
        width: "100%",
        maxWidth: colors.contentMaxWidth,
        flex: 1,
        flexDirection: "column",
        alignSelf: "center",
        gap: 16,
        overflowY: "auto",
        padding: "20px 24px 24px",
        ...style,
      }}
    >
      {transcript.length === 0 && !isWorking ? (
        <div style={{ margin: "auto", color: colors.inkSecondary, fontSize: 13 }}>{labels.empty}</div>
      ) : null}
      {transcript.map((row) => {
        if (row.type === "tool") {
          return renderToolCall ? (
            <div key={`tool:${row.item.id}`}>{renderToolCall(row.item)}</div>
          ) : (
            <AgentToolCall key={`tool:${row.item.id}`} toolCall={row.item} theme={colors} copy={labels} />
          );
        }
        return renderMessage ? (
          <div key={`message:${row.item.id}`}>{renderMessage(row.item)}</div>
        ) : (
          <AgentMessage key={`message:${row.item.id}`} message={row.item} theme={colors} copy={labels} />
        );
      })}
      {isWorking && !messages.some((message) => message.status === "streaming") ? (
        <div
          role="status"
          style={{ display: "flex", alignItems: "center", gap: 7, color: colors.inkSecondary, fontSize: 11 }}
        >
          <span aria-hidden="true" style={{ color: colors.inkTertiary, fontSize: 10 }}>✦</span>
          {labels.thinking}
        </div>
      ) : null}
      <div ref={end} />
    </div>
  );
}

export interface AgentComposerProps extends StyledProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  disabled?: boolean;
  error?: string | null;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onCancel?: () => void | Promise<void>;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  error,
  leadingActions,
  trailingActions,
  onCancel,
  className,
  style,
  theme,
  copy,
}: AgentComposerProps) {
  const context = useAgentContext();
  const colors = { ...context.theme, ...theme };
  const labels = { ...context.copy, ...copy };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (value.trim() && !disabled) void onSubmit();
    }
  };

  return (
    <div
      className={className}
      style={{
        width: "100%",
        maxWidth: colors.contentMaxWidth,
        margin: "0 auto",
        padding: "16px 24px 10px",
        ...style,
      }}
    >
      <div
        style={{
          display: "grid",
          gap: 8,
          padding: "12px 10px 10px 14px",
          background: colors.well,
          border: `1px solid ${error ? colors.statusBad : colors.hairline}`,
          borderRadius: 14,
        }}
      >
        <textarea
          aria-label={labels.placeholder}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? labels.sending : labels.placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            width: "100%",
            minHeight: 22,
            maxHeight: 160,
            resize: "vertical",
            border: 0,
            outline: 0,
            padding: 0,
            color: colors.ink,
            background: "transparent",
            fontFamily: colors.fontFamily,
            fontSize: 13,
            lineHeight: 1.45,
          }}
        />
        <div style={{ display: "flex", minHeight: 28, alignItems: "center", gap: 7 }}>
          {leadingActions}
          <span style={{ flex: 1 }} />
          {trailingActions}
          <button
            type="button"
            aria-label={disabled && onCancel ? "Stop agent" : labels.send}
            title={disabled && onCancel ? "Stop agent" : labels.send}
            disabled={disabled ? !onCancel : !value.trim()}
            onClick={() => void (disabled && onCancel ? onCancel() : onSubmit())}
            style={{
              display: "grid",
              width: 26,
              height: 26,
              placeItems: "center",
              padding: 0,
              border: 0,
              borderRadius: "50%",
              color: colors.canvas,
              background: disabled && !onCancel ? colors.inkTertiary : colors.ink,
              cursor: disabled && !onCancel ? "default" : !disabled && !value.trim() ? "default" : "pointer",
              opacity: !disabled && !value.trim() ? 0.38 : 1,
            }}
          >
            {disabled && onCancel ? (
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 1, background: colors.canvas }} />
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 9.5v-7M3.2 5.2 6 2.4l2.8 2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {error ? <div style={{ color: colors.statusBad, fontSize: 11, padding: "7px 4px 0" }}>{error}</div> : null}
    </div>
  );
}

export interface AgentChatProps extends StyledProps {
  sessionId: string;
  header?: ReactNode;
  composerLeadingActions?: ReactNode;
  composerTrailingActions?: ReactNode;
  /** @deprecated Prefer the header slot; the default chat has no header. */
  title?: string;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
  renderMessage?: (message: AgentChatMessage) => ReactNode;
  renderToolCall?: (toolCall: AgentToolCall) => ReactNode;
  onError?: (error: Error) => void;
}

export function AgentChat({
  sessionId,
  header,
  composerLeadingActions,
  composerTrailingActions,
  title,
  className,
  style,
  theme,
  copy,
  renderMessage,
  renderToolCall,
  onError,
}: AgentChatProps) {
  const context = useAgentContext();
  const colors = { ...context.theme, ...theme };
  const labels = { ...context.copy, ...copy };
  const session = useAgentSession(sessionId);
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isWorking =
    session.snapshot?.turns.some((turn) => turn.status === "queued" || turn.status === "running") ??
    false;
  const activeTurn = session.snapshot?.turns.find(
    (turn) => turn.status === "queued" || turn.status === "running",
  );

  const submit = async () => {
    const content = draft.trim();
    if (!content || isWorking) return;
    setDraft("");
    setSubmitError(null);
    try {
      await session.submit(content);
    } catch (error) {
      setDraft(content);
      const normalized = error instanceof Error ? error : new Error(String(error));
      setSubmitError(normalized.message);
      onError?.(normalized);
    }
  };

  return (
    <section
      className={className}
      style={{
        display: "flex",
        width: "100%",
        minHeight: 480,
        height: "100%",
        flexDirection: "column",
        overflow: "hidden",
        color: colors.ink,
        background: colors.canvas,
        fontFamily: colors.fontFamily,
        fontSize: 13,
        ...style,
      }}
    >
      {header ?? title ? (
        <header
          style={{
            width: "100%",
            maxWidth: colors.contentMaxWidth,
            margin: "0 auto",
            padding: "16px 24px 8px",
            color: colors.ink,
            fontSize: 15,
            fontWeight: 650,
          }}
        >
          {header ?? title}
        </header>
      ) : null}
      <div
        style={{
          display: "flex",
          width: "100%",
          minHeight: 0,
          flex: 1,
          flexDirection: "column",
        }}
      >
        {session.status === "loading" && session.messages.length === 0 ? (
          <div style={{ margin: "auto", color: colors.inkSecondary, fontSize: 13 }}>{labels.loading}</div>
        ) : (
          <AgentMessageList
            messages={session.messages}
            toolCalls={session.toolCalls}
            isWorking={isWorking}
            {...(renderMessage === undefined ? {} : { renderMessage })}
            {...(renderToolCall === undefined ? {} : { renderToolCall })}
            theme={colors}
            copy={labels}
          />
        )}
        <div
          style={{
            flex: "0 0 auto",
            background: `linear-gradient(to bottom, transparent 0, ${colors.canvas} 18%)`,
          }}
        >
          <AgentComposer
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            disabled={isWorking}
            error={submitError ?? session.error?.message ?? null}
            leadingActions={composerLeadingActions}
            trailingActions={composerTrailingActions}
            {...(activeTurn ? { onCancel: () => session.cancel(activeTurn.id) } : {})}
            theme={colors}
            copy={labels}
          />
        </div>
      </div>
    </section>
  );
}

export { createBrowserClient } from "./client";
export type { BrowserAgentClientOptions, SessionSnapshot } from "./types";

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
  surface: string;
  well: string;
  ink: string;
  inkSecondary: string;
  hairline: string;
  accent: string;
  accentText: string;
  danger: string;
  fontFamily: string;
  radius: number;
  contentMaxWidth: number;
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
}

const defaultTheme: AgentTheme = {
  canvas: "#f7f7f5",
  surface: "#ffffff",
  well: "#efefec",
  ink: "#191918",
  inkSecondary: "#6b6b66",
  hairline: "rgba(25, 25, 24, 0.12)",
  accent: "#191918",
  accentText: "#ffffff",
  danger: "#b42318",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  radius: 14,
  contentMaxWidth: 760,
};

const defaultCopy: AgentCopy = {
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
};

interface AgentContextValue {
  client: AgentClient;
  theme: AgentTheme;
  copy: AgentCopy;
  stores: Map<string, SessionStore>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export interface AgentProviderProps extends PropsWithChildren {
  client?: AgentClient;
  connection?: BrowserAgentClientOptions;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentProvider({ client, connection, theme, copy, children }: AgentProviderProps) {
  const resolvedClient = useMemo(() => {
    if (client && connection) throw new TypeError("AgentProvider accepts client or connection, not both");
    if (client) return client;
    if (connection) return createBrowserClient(connection);
    throw new TypeError("AgentProvider requires client or connection");
  }, [client, connection]);
  const stores = useMemo(() => new Map<string, SessionStore>(), [resolvedClient]);
  useEffect(() => () => {
    for (const store of stores.values()) store.dispose();
    stores.clear();
  }, [stores]);
  const value = useMemo(
    () => ({
      client: resolvedClient,
      theme: { ...defaultTheme, ...theme },
      copy: { ...defaultCopy, ...copy },
      stores,
    }),
    [resolvedClient, stores, theme, copy],
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

function stringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
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

interface SessionState {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: SessionSnapshot | null;
  events: AgentEvent[];
  messages: AgentChatMessage[];
  error: Error | null;
}

const initialSessionState: SessionState = {
  status: "idle",
  snapshot: null,
  events: [],
  messages: [],
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

interface StyledProps {
  className?: string;
  style?: CSSProperties;
}

export interface AgentMessageProps extends StyledProps {
  message: AgentChatMessage;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
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
        maxWidth: isUser ? "82%" : "100%",
        color: message.status === "failed" ? colors.danger : colors.ink,
        background: isUser ? colors.well : "transparent",
        borderRadius: isUser ? colors.radius : 0,
        padding: isUser ? "9px 12px" : "4px 0",
        fontSize: 15,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        ...style,
      }}
    >
      {message.content || fallback}
    </article>
  );
}

export interface AgentMessageListProps extends StyledProps {
  messages: readonly AgentChatMessage[];
  isWorking?: boolean;
  renderMessage?: (message: AgentChatMessage) => ReactNode;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentMessageList({
  messages,
  isWorking = false,
  renderMessage,
  className,
  style,
  theme,
  copy,
}: AgentMessageListProps) {
  const context = useAgentContext();
  const colors = { ...context.theme, ...theme };
  const labels = { ...context.copy, ...copy };
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, isWorking]);

  return (
    <div
      className={className}
      aria-live="polite"
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 18,
        overflowY: "auto",
        padding: "28px 24px 20px",
        ...style,
      }}
    >
      {messages.length === 0 && !isWorking ? (
        <div style={{ margin: "auto", color: colors.inkSecondary, fontSize: 14 }}>{labels.empty}</div>
      ) : null}
      {messages.map((message) =>
        renderMessage ? (
          <div key={message.id}>{renderMessage(message)}</div>
        ) : (
          <AgentMessage key={message.id} message={message} theme={colors} copy={labels} />
        ),
      )}
      {isWorking && !messages.some((message) => message.status === "streaming") ? (
        <div style={{ color: colors.inkSecondary, fontSize: 14 }}>{labels.thinking}</div>
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
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  error,
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
    <div className={className} style={{ padding: "12px 24px 18px", ...style }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 10,
          padding: "11px 11px 11px 14px",
          background: colors.surface,
          border: `1px solid ${error ? colors.danger : colors.hairline}`,
          borderRadius: colors.radius,
          boxShadow: "0 10px 30px rgba(20, 20, 18, 0.07)",
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
            minHeight: 24,
            maxHeight: 160,
            resize: "vertical",
            border: 0,
            outline: 0,
            padding: "3px 0",
            color: colors.ink,
            background: "transparent",
            font: "inherit",
            lineHeight: 1.5,
          }}
        />
        <button
          type="button"
          aria-label={labels.send}
          title={labels.send}
          disabled={disabled || !value.trim()}
          onClick={() => void onSubmit()}
          style={{
            width: 32,
            height: 32,
            border: 0,
            borderRadius: 10,
            color: colors.accentText,
            background: colors.accent,
            cursor: disabled || !value.trim() ? "default" : "pointer",
            opacity: disabled || !value.trim() ? 0.35 : 1,
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          ↑
        </button>
      </div>
      {error ? <div style={{ color: colors.danger, fontSize: 12, padding: "7px 4px 0" }}>{error}</div> : null}
    </div>
  );
}

export interface AgentChatProps extends StyledProps {
  sessionId: string;
  title?: string;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
  renderMessage?: (message: AgentChatMessage) => ReactNode;
  onError?: (error: Error) => void;
}

export function AgentChat({
  sessionId,
  title,
  className,
  style,
  theme,
  copy,
  renderMessage,
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
        border: `1px solid ${colors.hairline}`,
        borderRadius: colors.radius,
        fontFamily: colors.fontFamily,
        ...style,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          minHeight: 52,
          padding: "0 20px",
          borderBottom: `1px solid ${colors.hairline}`,
          background: colors.surface,
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: 99,
            background: session.status === "error" ? colors.danger : colors.accent,
            opacity: isWorking ? 0.55 : 1,
          }}
        />
        {title ?? labels.title}
      </header>
      <div
        style={{
          display: "flex",
          width: "100%",
          maxWidth: colors.contentMaxWidth,
          minHeight: 0,
          flex: 1,
          flexDirection: "column",
          alignSelf: "center",
        }}
      >
        {session.status === "loading" && session.messages.length === 0 ? (
          <div style={{ margin: "auto", color: colors.inkSecondary, fontSize: 14 }}>{labels.loading}</div>
        ) : (
          <AgentMessageList
            messages={session.messages}
            isWorking={isWorking}
            {...(renderMessage === undefined ? {} : { renderMessage })}
            theme={colors}
            copy={labels}
          />
        )}
        <AgentComposer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          disabled={isWorking}
          error={submitError ?? session.error?.message ?? null}
          theme={colors}
          copy={labels}
        />
      </div>
    </section>
  );
}

export { createBrowserClient } from "./client";
export type { BrowserAgentClientOptions, SessionSnapshot } from "./types";

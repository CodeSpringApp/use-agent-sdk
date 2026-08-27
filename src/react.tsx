import {
  createContext,
  createElement,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { createBrowserUseAgent, type AgentSession, type UseAgentClient } from "./client";
import type {
  BrowserUseAgentClientOptions,
  SessionSnapshot,
  SubmitOptions,
  SubmitTurnResponse,
} from "./types";

const UseAgentContext = createContext<UseAgentClient | null>(null);

export interface UseAgentProviderProps extends PropsWithChildren {
  client?: UseAgentClient;
  connection?: BrowserUseAgentClientOptions;
}

export function UseAgentProvider({ client, connection, children }: UseAgentProviderProps) {
  const resolved = useMemo(() => {
    if (client) return client;
    if (connection) return createBrowserUseAgent(connection);
    throw new TypeError("UseAgentProvider requires client or connection");
  }, [client, connection]);
  return createElement(UseAgentContext.Provider, { value: resolved }, children);
}

export function useAgentClient(): UseAgentClient {
  const client = useContext(UseAgentContext);
  if (!client) throw new Error("useAgentClient must be used inside UseAgentProvider");
  return client;
}

interface SessionState {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: SessionSnapshot | null;
  error: Error | null;
}

class SessionStore {
  private state: SessionState = { status: "idle", snapshot: null, error: null };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;

  constructor(readonly session: AgentSession) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;
  getServerSnapshot = () => ({ status: "idle", snapshot: null, error: null }) as SessionState;

  private setState(state: SessionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  async refresh() {
    this.controller?.abort();
    this.controller = new AbortController();
    this.setState({ ...this.state, status: this.state.snapshot ? "ready" : "loading", error: null });
    try {
      const snapshot = await this.session.get({ signal: this.controller.signal });
      this.setState({ status: "ready", snapshot, error: null });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.setState({
        status: "error",
        snapshot: this.state.snapshot,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  dispose() {
    this.controller?.abort();
  }
}

export interface UseAgentSessionResult extends SessionState {
  session: AgentSession;
  refresh: () => Promise<void>;
  submit: (content: string, options?: SubmitOptions) => Promise<SubmitTurnResponse>;
  cancel: (turnId: string) => Promise<void>;
}

export function useAgentSession(sessionId: string): UseAgentSessionResult {
  const client = useAgentClient();
  const store = useMemo(() => new SessionStore(client.sessions.get(sessionId)), [client, sessionId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  useEffect(() => {
    void store.refresh();
    return () => store.dispose();
  }, [store]);

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

export { createBrowserUseAgent } from "./client";
export type { BrowserUseAgentClientOptions, SessionSnapshot } from "./types";

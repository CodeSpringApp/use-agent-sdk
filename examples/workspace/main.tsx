// Local interactive fixture. No provider requests or real credentials.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentProvider, AgentWorkspace, createAgentAppearance, createBrowserClient } from "../../src/react";
import type { AgentEvent, AgentWebSocket, AgentWebSocketEventMap } from "../../src/types";
const now = () => new Date().toISOString();
const histories: Record<string, AgentEvent[]> = {};
const files: Record<string, { path: string; content: string; version: number; sizeBytes: number }> = {};
const sockets = new Map<string, Set<Socket>>();
const turns: Record<string, Array<{ id: string; status: string; attempt: number; createdAt: string; updatedAt: string }>> = {};
const pending = new Map<string, ReturnType<typeof setTimeout>>();
class Socket implements AgentWebSocket {
  readyState = 1;
  target = new EventTarget();
  constructor(readonly id: string) { const group = sockets.get(id) ?? new Set(); group.add(this); sockets.set(id, group); queueMicrotask(() => { this.target.dispatchEvent(new Event("open")); this.target.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "replay.completed", cursor: (histories[id] ?? []).length, hasMore: false }) })); }); }
  addEventListener<K extends keyof AgentWebSocketEventMap>(type: K, listener: (event: AgentWebSocketEventMap[K]) => void) { this.target.addEventListener(type, listener as EventListener); }
  send() {}
  close() { this.readyState = 3; sockets.get(this.id)?.delete(this); }
}
function emit(sessionId: string, turnId: string, type: string, data: unknown) {
  const events = histories[sessionId] ??= [];
  const event: AgentEvent = { schemaVersion: 1, id: events.length + 1, sessionId, turnId, attempt: 1, type, createdAt: now(), data };
  const statuses: Record<string, string> = { "turn.queued": "queued", "turn.started": "running", "turn.completed": "completed", "turn.cancelled": "cancelled" };
  if (statuses[type]) { const list = turns[sessionId] ??= []; const existing = list.find(turn => turn.id === turnId); if (existing) existing.status = statuses[type]!; else list.push({ id: turnId, status: statuses[type]!, attempt: 1, createdAt: now(), updatedAt: now() }); }
  events.push(event); for (const socket of sockets.get(sessionId) ?? []) socket.target.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event }) }));
}
const client = createBrowserClient({ endpoint: "https://fixture.invalid/browser", getClientToken: async () => "local-fixture", webSocket: url => new Socket(new URL(url).pathname.split("/")[4]!), fetch: async (input, init) => {
  const url = new URL(String(input)); const id = url.pathname.split("/")[4]!; const events = histories[id] ?? [];
  if (url.pathname.endsWith("/websocket-tickets")) return Response.json({ ticket: "a".repeat(80), expiresAt: new Date(Date.now() + 60000).toISOString() });
  if (url.pathname.endsWith("/events")) return Response.json({ events: events.filter(event => event.id > Number(url.searchParams.get("after") ?? 0)), cursor: events.length, hasMore: false });
  if (url.pathname.endsWith("/workspace")) {
    if (new URLSearchParams(location.search).has("slow")) await new Promise(resolve => setTimeout(resolve, 800));
    return Response.json({ executionHarness: "codex_wasm_v1", files: files[id] ? [files[id]] : [], file: url.searchParams.has("path") ? files[id] ?? null : null });
  }
  if (url.pathname.endsWith("/cancel")) { clearTimeout(pending.get(id)); pending.delete(id); emit(id, url.pathname.split("/")[6]!, "turn.cancelled", {}); return Response.json({ status: "cancelled" }); }
  if (url.pathname.endsWith("/turns")) {
    const { content } = JSON.parse(String(init?.body)); const turnId = crypto.randomUUID();
    emit(id, turnId, "message.input", { content }); emit(id, turnId, "turn.queued", {}); emit(id, turnId, "turn.started", {});
    pending.set(id, setTimeout(() => {
      const content = `# ${id === "first" ? "First" : "Second"} session\n\nSaved from your task.\n\n- Review the notes\n- Share the result\n`;
      files[id] = { path: "notes.md", content, version: (files[id]?.version ?? 0) + 1, sizeBytes: new TextEncoder().encode(content).length };
      emit(id, turnId, "message.started", {}); emit(id, turnId, "message.completed", { content: "Saved notes.md." }); emit(id, turnId, "turn.completed", {}); pending.delete(id);
    }, 2000));
    return Response.json({ sessionId: id, turnId, status: "queued", cursor: events.length, duplicate: false }, { status: 202 });
  }
  return Response.json({ sessionId: id, agentRevisionId: "writer@1", executionHarness: "codex_wasm_v1", createdAt: now(), updatedAt: now(), cursor: events.length, turns: turns[id] ?? [] });
} });
const appearance = createAgentAppearance({ mode: new URLSearchParams(location.search).has("light") ? "light" : "dark" });
function App() { const [id, setId] = useState("first"); return <AgentProvider client={client} appearance={appearance}><AgentWorkspace sessionId={id} title={`${id === "first" ? "First" : "Second"} session`} style={{ height: "100dvh" }} actions={<button onClick={() => setId(id === "first" ? "second" : "first")}>Switch session</button>}/></AgentProvider>; }
document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(<App/>);

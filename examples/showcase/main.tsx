import React from "react";
import { createRoot } from "react-dom/client";
import {
  AgentProvider,
  AgentChat,
  createAgentAppearance,
  createBrowserClient,
} from "../../src/react";

const now = "2026-08-27T09:30:00.000Z";
const sessionId = "showcase-session";
const turnId = "showcase-turn";
const answer = `### Delivery update

Your package left our Mumbai facility this morning and is now in transit to Bengaluru.

- **Expected delivery:** Friday, 29 August
- **Tracking status:** In transit

I’ll keep monitoring it and let you know if the delivery window changes.`;

const events = [
  { schemaVersion: 1, id: 1, sessionId, attempt: 0, type: "session.created", createdAt: now, data: { agentRevisionId: "support@7" } },
  { schemaVersion: 1, id: 2, sessionId, turnId, attempt: 0, type: "message.input", createdAt: now, data: { content: "Can you check when my order will arrive?" } },
  { schemaVersion: 1, id: 3, sessionId, turnId, attempt: 0, type: "turn.queued", createdAt: now, data: {} },
  { schemaVersion: 1, id: 4, sessionId, turnId, attempt: 1, type: "turn.started", createdAt: now, data: {} },
  { schemaVersion: 1, id: 5, sessionId, turnId, attempt: 1, type: "message.started", createdAt: now, data: {} },
  {
    schemaVersion: 1,
    id: 6,
    sessionId,
    turnId,
    attempt: 1,
    type: "tool.call.started",
    createdAt: now,
    data: {
      toolCallId: "lookup-CS-1042",
      name: "commerce.lookup_order",
      label: "Look up order",
      summary: "CS-1042",
      input: { orderId: "CS-1042" },
    },
  },
  {
    schemaVersion: 1,
    id: 7,
    sessionId,
    turnId,
    attempt: 1,
    type: "tool.call.completed",
    createdAt: now,
    data: {
      toolCallId: "lookup-CS-1042",
      name: "commerce.lookup_order",
      summary: "CS-1042",
      output: { status: "in_transit", expectedDelivery: "2026-08-29" },
    },
  },
  {
    schemaVersion: 1,
    id: 8,
    sessionId,
    turnId,
    attempt: 1,
    type: "tool.call.started",
    createdAt: now,
    data: {
      toolCallId: "delivery-CS-1042",
      name: "logistics.delivery_estimate",
      label: "Check delivery estimate",
      summary: "Mumbai → Bengaluru",
      input: { origin: "Mumbai", destination: "Bengaluru", service: "priority" },
    },
  },
  {
    schemaVersion: 1,
    id: 9,
    sessionId,
    turnId,
    attempt: 1,
    type: "tool.call.completed",
    createdAt: now,
    data: {
      toolCallId: "delivery-CS-1042",
      name: "logistics.delivery_estimate",
      summary: "Mumbai → Bengaluru",
      output: { expectedDelivery: "2026-08-29", confidence: "high" },
    },
  },
  { schemaVersion: 1, id: 10, sessionId, turnId, attempt: 1, type: "message.completed", createdAt: now, data: { content: answer } },
  { schemaVersion: 1, id: 11, sessionId, turnId, attempt: 1, type: "turn.completed", createdAt: now, data: {} },
];

const client = createBrowserClient({
  endpoint: "http://localhost:8787/browser",
  getClientToken: async () => "showcase-token",
  fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/events")) {
      return Response.json({ events, cursor: events.length, hasMore: false });
    }
    if (url.pathname.endsWith(`/sessions/${sessionId}`)) {
      return Response.json({
        sessionId,
        agentRevisionId: "support@7",
        createdAt: now,
        updatedAt: now,
        cursor: events.length,
        turns: [{ id: turnId, status: "completed", attempt: 1, createdAt: now, updatedAt: now }],
      });
    }
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  },
});

const dark = new URLSearchParams(window.location.search).get("theme") === "dark";
const appearance = createAgentAppearance({ mode: dark ? "dark" : "light" });

function Showcase() {
  return (
    <main>
      <div className="caption">
        <div>
          <div className="eyebrow">use-agent / React</div>
          <h1>Paper agent experience</h1>
        </div>
        <span>Durable tools · resumable sessions</span>
      </div>
      <div className="frame">
        <AgentProvider client={client} appearance={appearance}>
          <AgentChat sessionId={sessionId} style={{ height: "100%" }} />
        </AgentProvider>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Showcase />);

const style = document.createElement("style");
style.textContent = `
  * { box-sizing: border-box; }
  html, body, #root { min-height: 100%; margin: 0; }
  body { background: ${dark ? "#101012" : "#F5F5F8"}; color: ${dark ? "#ECECEC" : "#141414"}; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
  main { width: min(960px, calc(100% - 48px)); margin: 0 auto; padding: 36px 0 42px; }
  .caption { display: flex; align-items: flex-end; justify-content: space-between; margin: 0 0 18px; }
  .caption > span { color: ${dark ? "#66666B" : "#9B9BA0"}; font-size: 11px; }
  .eyebrow { margin-bottom: 5px; color: ${dark ? "#98989D" : "#68686D"}; font-size: 11px; font-weight: 550; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 19px; font-weight: 650; line-height: 1.2; letter-spacing: -.015em; }
  .frame { height: 650px; overflow: hidden; background: ${dark ? "#161618" : "#FFFFFF"}; border: 1px solid ${dark ? "#29292C" : "#E4E4E8"}; }
`;
document.head.append(style);

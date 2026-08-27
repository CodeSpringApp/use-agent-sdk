import React from "react";
import { createRoot } from "react-dom/client";
import { AgentProvider, AgentChat, createBrowserClient } from "../../src/react";

const now = "2026-08-27T09:30:00.000Z";
const sessionId = "showcase-session";
const turnId = "showcase-turn";
const answer = `Based on the order details, your package left our Mumbai facility this morning.

Expected delivery: Friday, 29 August
Tracking status: In transit

I’ll keep monitoring it and let you know if the delivery window changes.`;

const events = [
  { schemaVersion: 1, id: 1, sessionId, attempt: 0, type: "session.created", createdAt: now, data: { agentRevisionId: "support@7" } },
  { schemaVersion: 1, id: 2, sessionId, turnId, attempt: 0, type: "message.input", createdAt: now, data: { content: "Can you check when my order will arrive?" } },
  { schemaVersion: 1, id: 3, sessionId, turnId, attempt: 0, type: "turn.queued", createdAt: now, data: {} },
  { schemaVersion: 1, id: 4, sessionId, turnId, attempt: 1, type: "turn.started", createdAt: now, data: {} },
  { schemaVersion: 1, id: 5, sessionId, turnId, attempt: 1, type: "message.started", createdAt: now, data: {} },
  { schemaVersion: 1, id: 6, sessionId, turnId, attempt: 1, type: "message.completed", createdAt: now, data: { content: answer } },
  { schemaVersion: 1, id: 7, sessionId, turnId, attempt: 1, type: "turn.completed", createdAt: now, data: {} },
];

const client = createBrowserClient({
  endpoint: "http://localhost:8787",
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

const retail = new URLSearchParams(window.location.search).get("theme") === "retail";

function Showcase() {
  const appearance = retail
    ? {
        theme: {
          canvas: "#f4f7fb",
          surface: "#ffffff",
          well: "#e8eef8",
          ink: "#10233f",
          inkSecondary: "#66758a",
          hairline: "rgba(16, 35, 63, 0.13)",
          accent: "#2856d8",
          accentText: "#ffffff",
          radius: 18,
        },
        copy: {
          title: "Northstar concierge",
          assistantLabel: "Northstar concierge",
          placeholder: "Ask about an order, return, or product",
          empty: "How can we help today?",
        },
      }
    : {};

  return (
    <main>
      <div className="eyebrow">{retail ? "Client-themed example" : "Default components"}</div>
      <h1>{retail ? "Northstar order concierge" : "A support agent built with use-agent"}</h1>
      <p className="lede">
        {retail
          ? "The same agent UI with theme and copy overrides."
          : "Ferb-inspired defaults, backed by durable session events."}
      </p>
      <div className="frame">
        <AgentProvider client={client} {...appearance}>
          <AgentChat sessionId={sessionId} style={{ height: 590 }} />
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
  body { background: ${retail ? "#e9eef7" : "#ecece8"}; color: #191918; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
  main { width: min(1040px, calc(100% - 48px)); margin: 0 auto; padding: 48px 0 64px; }
  .eyebrow { margin-bottom: 12px; color: ${retail ? "#2856d8" : "#6b6b66"}; font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  h1 { max-width: 720px; margin: 0; font-size: 36px; line-height: 1.1; letter-spacing: -.035em; }
  .lede { margin: 12px 0 28px; color: #6b6b66; font-size: 16px; }
  .frame { padding: 14px; background: rgba(255,255,255,.52); border: 1px solid rgba(25,25,24,.1); border-radius: 24px; box-shadow: 0 28px 70px rgba(30,30,25,.11); }
`;
document.head.append(style);

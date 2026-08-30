import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserClient } from "../src";
import {
  AgentMessage,
  AgentProvider,
  agentThemeVariables,
  createAgentAppearance,
  createAgentClient,
  paperDarkTheme,
  paperLightTheme,
  reduceAgentMessages,
  reduceAgentToolCalls,
  type AgentChatMessage,
} from "../src/react";
import type { AgentEvent } from "../src/types";

const base = {
  schemaVersion: 1 as const,
  sessionId: "session-1",
  turnId: "turn-1",
  createdAt: "2026-08-27T09:30:00.000Z",
};

describe("React SDK", () => {
  test("creates a stable browser client from a same-origin token endpoint", async () => {
    const requests: string[] = [];
    const client = createAgentClient({
      endpoint: "http://localhost:8787/browser",
      clientTokenEndpoint: "/api/agents/token",
      fetch: async (input, init) => {
        requests.push(String(input));
        if (String(input) === "/api/agents/token") {
          expect(init?.method).toBe("POST");
          return Response.json({ token: "client-token", expiresAt: Date.now() + 300_000 });
        }
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer client-token");
        return Response.json({
          sessionId: "session-1",
          agentRevisionId: "support@7",
          createdAt: base.createdAt,
          updatedAt: base.createdAt,
          cursor: 0,
          turns: [],
        });
      },
    });

    expect(requests).toEqual([]);
    await client.sessions.get("session-1").get();
    expect(requests).toEqual(["/api/agents/token", "http://localhost:8787/browser/v1/sessions/session-1"]);
  });

  test("pins Ferb Paper light and dark palettes", () => {
    expect(agentThemeVariables.accent).toBe("--codespring-agent-accent");
    expect(agentThemeVariables.contentMaxWidth).toBe("--codespring-agent-content-max-width");
    expect(Object.keys(agentThemeVariables).sort()).toEqual(Object.keys(paperLightTheme).sort());
    expect(paperLightTheme).toMatchObject({
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
    });
    expect(paperDarkTheme).toMatchObject({
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
    expect(Object.isFrozen(createAgentAppearance())).toBe(true);
  });
  test("reduces durable input and retry events into visible messages", () => {
    const events: AgentEvent[] = [
      { ...base, id: 1, attempt: 0, type: "message.input", data: { content: "Hello" } },
      { ...base, id: 2, attempt: 1, type: "message.started", data: {} },
      { ...base, id: 3, attempt: 1, type: "message.delta", data: { delta: "Discard me" } },
      { ...base, id: 4, attempt: 1, type: "message.attempt_abandoned", data: {} },
      { ...base, id: 5, attempt: 2, type: "message.started", data: {} },
      { ...base, id: 6, attempt: 2, type: "message.completed", data: { content: "Hi there" } },
    ];

    expect(reduceAgentMessages(events).map(({ role, content, status }) => ({ role, content, status }))).toEqual([
      { role: "user", content: "Hello", status: "completed" },
      { role: "assistant", content: "Hi there", status: "completed" },
    ]);
  });

  test("provider and presentational components render during SSR", () => {
    const client = createBrowserClient({
      endpoint: "http://localhost:8787/browser",
      getClientToken: async () => "token",
    });
    const message: AgentChatMessage = {
      id: "turn-1:user",
      turnId: "turn-1",
      attempt: 0,
      role: "user",
      content: "Where is my order?",
      status: "completed",
      createdAt: base.createdAt,
      eventId: 1,
    };

    const html = renderToStaticMarkup(
      <AgentProvider client={client} copy={{ userLabel: "Customer" }}>
        <AgentMessage message={message} />
      </AgentProvider>,
    );

    expect(html).toContain("Where is my order?");
    expect(html).toContain('aria-label="Customer"');
    expect(html).toContain("var(--codespring-agent-well, #F5F5F8)");

    const themedHtml = renderToStaticMarkup(
      <AgentProvider client={client}>
        <AgentMessage message={message} theme={{ well: "#ABCDEF" }} />
      </AgentProvider>,
    );
    expect(themedHtml).toContain("var(--codespring-agent-well, #ABCDEF)");
    expect(themedHtml).not.toContain("var(--codespring-agent-well, var(--codespring-agent-well");
  });

  test("reduces the canonical runtime compatibility fixture", async () => {
    const events = await Bun.file(
      new URL("./fixtures/session-with-tools.v1.json", import.meta.url),
    ).json() as AgentEvent[];

    expect(reduceAgentMessages(events).map(({ role, content, status }) => ({ role, content, status }))).toEqual([
      { role: "user", content: "Where is order 1042?", status: "completed" },
      { role: "assistant", content: "I’ll check that.", status: "completed" },
      { role: "assistant", content: "Order 1042 is in transit.", status: "completed" },
    ]);

    expect(reduceAgentToolCalls(events)).toEqual([
      expect.objectContaining({
        id: "tool:22222222-2222-4222-8222-222222222222:0:1",
        operationId: "tool:22222222-2222-4222-8222-222222222222:0:1",
        callId: "call_01",
        revision: "1",
        risk: "read",
        name: "codespring_echo",
        label: "codespring_echo",
        status: "completed",
        input: { value: "order-1042" },
        output: { value: "order-1042" },
      }),
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserClient } from "../src";
import {
  AgentMessage,
  AgentProvider,
  createAgentAppearance,
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
  test("pins Ferb Paper light and dark palettes", () => {
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
      endpoint: "http://localhost:8787",
      getClientToken: async () => "token",
    });
    const message: AgentChatMessage = {
      id: "turn-1:user",
      turnId: "turn-1",
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
  });

  test("reduces durable tool lifecycle events", () => {
    const events: AgentEvent[] = [
      {
        ...base,
        id: 1,
        attempt: 1,
        type: "tool.call.started",
        data: { toolCallId: "call-1", name: "orders.lookup", label: "Look up order", summary: "CS-1042", input: { orderId: "CS-1042" } },
      },
      {
        ...base,
        id: 2,
        attempt: 1,
        type: "tool.call.completed",
        data: { toolCallId: "call-1", name: "orders.lookup", output: { status: "in_transit" } },
      },
    ];

    expect(reduceAgentToolCalls(events)).toEqual([
      expect.objectContaining({
        id: "call-1",
        name: "orders.lookup",
        label: "Look up order",
        summary: "CS-1042",
        status: "completed",
        input: { orderId: "CS-1042" },
        output: { status: "in_transit" },
      }),
    ]);
  });
});

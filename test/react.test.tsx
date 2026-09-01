import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserClient } from "../src";
import {
  AgentCodeBlock,
  AgentComposer,
  AgentGenerativeUI,
  AgentMarkdown,
  AgentMessage,
  AgentProvider,
  AgentThinkingIndicator,
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

  test("preserves the global receiver for browser fetch requests", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async function (this: typeof globalThis, input, init) {
      expect(this).toBe(globalThis);
      requests.push(String(input));
      if (String(input) === "/api/agents/token") {
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
    }) as typeof fetch;

    try {
      const client = createAgentClient({
        endpoint: "http://localhost:8787/browser",
        clientTokenEndpoint: "/api/agents/token",
      });
      await client.sessions.get("session-1").get();
      expect(requests).toEqual([
        "/api/agents/token",
        "http://localhost:8787/browser/v1/sessions/session-1",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test("associates durable token usage with the terminal assistant message", () => {
    const messages = reduceAgentMessages([
      { ...base, id: 1, attempt: 1, type: "message.started", data: { itemId: "message-1" } },
      { ...base, id: 2, attempt: 1, type: "message.completed", data: { itemId: "message-1", content: "Done" } },
      { ...base, id: 3, attempt: 1, type: "usage.recorded", data: {
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 20,
        reasoningTokens: 4,
      } },
    ]);

    expect(messages[0]?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 20,
      reasoningTokens: 4,
      totalTokens: 150,
    });
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

  test("renders only explicitly configured message actions", () => {
    const client = createBrowserClient({
      endpoint: "http://localhost:8787/browser",
      getClientToken: async () => "token",
    });
    const message: AgentChatMessage = {
      id: "turn-1:assistant:1",
      turnId: "turn-1",
      attempt: 1,
      role: "assistant",
      content: "A useful answer",
      status: "completed",
      createdAt: base.createdAt,
      eventId: 3,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 125,
      },
    };

    const plain = renderToStaticMarkup(
      <AgentProvider client={client}><AgentMessage message={message}/></AgentProvider>,
    );
    expect(plain).not.toContain("Helpful response");
    expect(plain).not.toContain("tokens");

    const configured = renderToStaticMarkup(
      <AgentProvider client={client}>
        <AgentMessage
          message={message}
          actions={{ copy: true, feedback: "binary", usage: "tokens" }}
          onFeedback={() => undefined}
        />
      </AgentProvider>,
    );
    expect(configured).toContain("Copy");
    expect(configured).toContain("Helpful response");
    expect(configured).toContain("125 tokens");
  });

  test("renders hardened GFM and reusable code blocks during SSR", () => {
    const client = createBrowserClient({
      endpoint: "http://localhost:8787/browser",
      getClientToken: async () => "token",
    });
    const markdown = [
      "## Result",
      "",
      "- [x] Parsed **safely**",
      "- [ ] Ship it",
      "",
      "| Item | State |",
      "| --- | --- |",
      "| Markdown | ready |",
      "",
      "```typescript",
      "const ready: boolean = true;",
      "```",
      "",
      "<script>globalThis.compromised = true</script>",
    ].join("\n");

    const html = renderToStaticMarkup(
      <AgentProvider client={client}>
        <AgentMarkdown>{markdown}</AgentMarkdown>
        <AgentCodeBlock code={'const id = "agent";'} language="typescript" />
      </AgentProvider>,
    );

    expect(html).toContain("<h2");
    expect(html).toContain("<table");
    expect(html).toContain("Parsed <strong");
    expect(html.match(/data-codespring-agent-code=""/gu)).toHaveLength(2);
    expect(html).toContain("const ready: boolean = true;");
    expect(html).toContain("const id = &quot;agent&quot;;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("globalThis.compromised");
  });

  test("renders product-neutral generative controls without a runtime provider", () => {
    const html = renderToStaticMarkup(
      <AgentGenerativeUI
        request={{
          requestId: "priority",
          kind: "choice",
          title: "Choose a priority",
          options: [
            { id: "quality", label: "Best quality", description: "Prefer stronger answers" },
            { id: "speed", label: "Faster responses" },
          ],
        }}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain('data-codespring-agent-ui="choice"');
    expect(html).toContain("Choose a priority");
    expect(html).toContain("Best quality");
    expect(html).not.toContain("agent-builder");
    expect(html).not.toContain("control-plane");
  });

  test("keeps multi-select checkboxes fixed beside wrapping copy", () => {
    const html = renderToStaticMarkup(
      <AgentGenerativeUI
        request={{
          requestId: "capabilities",
          kind: "multi_select",
          title: "Choose capabilities",
          options: [{
            id: "vision",
            label: "Vision",
            description: "A deliberately long description that can wrap without compressing the native checkbox.",
          }],
        }}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("width:16px");
    expect(html).toContain("height:16px");
    expect(html).toContain("flex:0 0 16px");
    expect(html).toContain("min-height:36px");
  });

  test("uses neutral confirmation copy unless a host supplies the real effect", () => {
    const fallback = renderToStaticMarkup(
      <AgentGenerativeUI
        request={{
          requestId: "review",
          kind: "review",
          title: "Review",
          items: [{ id: "scope", label: "Scope", value: "One resource" }],
        }}
        onSubmit={() => undefined}
      />,
    );
    const explicit = renderToStaticMarkup(
      <AgentGenerativeUI
        request={{
          requestId: "publish",
          kind: "review",
          title: "Review",
          submitLabel: "Publish new version",
          items: [{ id: "scope", label: "Scope", value: "One resource" }],
        }}
        onSubmit={() => undefined}
      />,
    );

    expect(fallback).toContain("Confirm");
    expect(fallback).not.toContain(">Approve<");
    expect(explicit).toContain("Publish new version");
  });

  test("renders an auto-growing composer without the browser resize control", () => {
    const html = renderToStaticMarkup(
      <AgentProvider client={createBrowserClient({
        endpoint: "http://localhost:8787/browser",
        getClientToken: async () => "test-token",
      })}>
        <AgentComposer
          value={"First line\nSecond line"}
          onChange={() => undefined}
          onSubmit={() => undefined}
        />
      </AgentProvider>,
    );

    expect(html).toContain("resize:none");
    expect(html).toContain("overflow-y:hidden");
    expect(html).toContain("max-height:11.6em");
    expect(html).not.toContain("resize:vertical");
  });

  test("renders Ferb-style thinking motion with rotating copy and elapsed time", () => {
    const html = renderToStaticMarkup(
      <AgentThinkingIndicator startedAt={Date.now()} />,
    );

    expect(html).toContain("data-codespring-agent-thinking-sparkle");
    expect(html).toContain("data-codespring-agent-thinking-label");
    expect(html).toContain("codespring-agent-thinking-shimmer");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("Thinking…");
    expect(html).toContain("0.0s");
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

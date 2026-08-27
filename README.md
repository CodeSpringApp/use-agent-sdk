# `@codespring-app/use-agent`

The supported server and React SDK for CodeSpring Agents. The package speaks a
versioned HTTP protocol and contains no Cloudflare runtime implementation, so
the same application can target CodeSpring-hosted or self-hosted endpoints.

## Server

```ts
import { createAgent, createUseAgent } from "@codespring-app/use-agent";

const support = createAgent({
  id: "support",
  revision: "7",
  instructions: "Help the customer clearly and safely.",
  model: { provider: "anthropic", model: "claude-sonnet" },
  skills: [{ id: "returns", version: "1" }],
});

const agents = createUseAgent({
  endpoint: process.env.CODESPRING_AGENTS_ENDPOINT!,
  apiKey: process.env.CODESPRING_AGENTS_API_KEY!,
});

const session = await agents.sessions.create(support);
await session.submit("Where is my order?", { idempotencyKey: crypto.randomUUID() });
```

API keys are server-only. Do not pass the server client into a browser bundle.

## React

```tsx
import { UseAgentProvider, useAgentSession } from "@codespring-app/use-agent/react";

export function App() {
  return (
    <UseAgentProvider
      connection={{
        endpoint: "https://api.agents.codespring.app",
        getClientToken: () => fetch("/api/agents/token", { method: "POST" }).then((r) => r.text()),
      }}
    >
      <Conversation sessionId="..." />
    </UseAgentProvider>
  );
}

function Conversation({ sessionId }: { sessionId: string }) {
  const session = useAgentSession(sessionId);
  if (session.status === "loading") return <p>Loading…</p>;
  if (session.error) return <p>{session.error.message}</p>;
  return <pre>{JSON.stringify(session.snapshot, null, 2)}</pre>;
}
```

The React entrypoint only accepts a short-lived client-token callback. The
client-token endpoint is part of the platform roadmap and must be implemented
before using this flow in production.

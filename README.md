# `@codespring-app/use-agent`

The supported server and React SDK for CodeSpring Agents. It speaks a versioned
HTTP protocol and contains no Cloudflare runtime implementation, so the same
application can target CodeSpring-hosted or self-hosted endpoints.

![An agent built with the use-agent React SDK](./docs/screenshots/default-agent.png)

## Server

```ts
import { createAgent, createClient } from "@codespring-app/use-agent";

const support = createAgent({
  id: "support",
  revision: "7",
  instructions: "Help the customer clearly and safely.",
  model: "production-default",
  skills: [{ id: "returns", version: "1" }],
});

const agents = createClient({
  endpoint: process.env.CODESPRING_AGENTS_ENDPOINT!,
  apiKey: process.env.CODESPRING_AGENTS_API_KEY!,
});

const session = await agents.sessions.create(support);
await session.submit("Where is my order?", { idempotencyKey: crypto.randomUUID() });
```

`production-default` is a reusable, tenant-scoped virtual model profile—not a
provider model name and not an agent/use-case configuration. Multiple agents can
reference it. The control plane maps it to encrypted BYOK connections, provider
candidates, fallback, budgets, and policy. Publishing resolves the profile to an
immutable policy revision while credential rotation remains independent.

API keys are server-only. Do not pass the server client into a browser bundle.

## Plug-and-play React UI

```tsx
import {
  AgentChat,
  AgentProvider,
  createAgentAppearance,
  useAgentConnection,
} from "@codespring-app/use-agent/react";

const acmeAppearance = createAgentAppearance({
  theme: { accent: "#2856D8" },
  copy: { placeholder: "Ask us anything" },
});

export function App({ sessionId }: { sessionId: string }) {
  const client = useAgentConnection({
    endpoint: "https://api.agents.codespring.app",
    clientTokenEndpoint: "/api/agents/token",
  });

  return (
    <AgentProvider client={client} appearance={acmeAppearance}>
      <AgentChat sessionId={sessionId} />
    </AgentProvider>
  );
}
```

`/api/agents/token` returns `{ token, expiresAt }`. The SDK caches it in memory,
deduplicates concurrent refreshes, refreshes before expiry, and retries once
after a 401. It never persists the token. `createAgentAppearance` produces a
frozen, reusable preset so unrelated renders do not invalidate theme/copy
consumers; use `useMemo` when appearance must be dynamic.

The defaults implement Ferb's Paper experience: assistant replies are document
content on an edge-to-edge canvas, user messages are quiet trailing wells, tool
calls are compact inspectable activity rows, and the live-edge composer has no
shadow. `paperLightTheme`, `paperDarkTheme`, theme/copy overrides, slots, and
render functions are available for customization.

## Headless React

Advanced clients can use `useAgentSession`, `useAgentMessages`,
`useAgentToolCalls`, `useAgentClient`, `useAgentTheme`, and `useAgentCopy` to
build a completely custom interface. The composable `AgentMessageList`,
`AgentMessage`, `AgentToolCall`, and `AgentComposer` primitives can also be
mixed with client-owned components.

The React entrypoint only accepts a short-lived client-token callback. The
client-token endpoint is part of the platform roadmap and must be implemented
before using this flow in production.

## Local showcase

```sh
bun run showcase
```

Open `http://127.0.0.1:5173` for the Paper UI or append `?theme=dark` for
the dark palette. The showcase uses mocked durable events and makes no
external API calls.

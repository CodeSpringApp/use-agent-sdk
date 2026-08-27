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
  createAgentClient,
} from "@codespring-app/use-agent/react";

const agentClient = createAgentClient({
  endpoint: "https://api.agents.codespring.app/browser",
  clientTokenEndpoint: "/api/agents/token",
});

const acmeAppearance = createAgentAppearance({
  theme: { accent: "#2856D8" },
  copy: { placeholder: "Ask us anything" },
});

export function App({ sessionId }: { sessionId: string }) {
  return (
    <AgentProvider client={agentClient} appearance={acmeAppearance}>
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

The `/browser` endpoint is intentional: it accepts only short-lived client
tokens and is the only runtime surface with browser CORS. Server API keys stay
on the endpoint root and must never be shipped to a browser.

The default Paper experience renders assistant replies as document content on
an edge-to-edge canvas, user messages as quiet trailing wells, tool calls as
compact inspectable activity rows, and the live-edge composer without a shadow.
`paperLightTheme`, `paperDarkTheme`, theme/copy overrides, slots, and render
functions are available for customization.

## CSS variables, Tailwind CSS, and StyleX

Every default component resolves theme tokens through inherited
`--codespring-agent-*` custom properties. Variables override the appearance
preset; unset variables use the selected Paper or custom appearance value as a
fallback.

```css
.acme-agent-theme {
  --codespring-agent-accent: #2856d8;
  --codespring-agent-container-radius: 18px;
  --codespring-agent-content-max-width: 52rem;
}
```

The public names are also exported as `agentThemeVariables`. Supported tokens
are `canvas`, `ink`, `inkSecondary`, `inkTertiary`, `well`, `hairline`,
`statusGood`, `statusBad`, `statusWarn`, `accent`, `fontFamily`, `monoFamily`,
`contentMaxWidth`, `containerRadius`, and `wellRadius`.

Tailwind CSS can set the variables on any ancestor:

```css
@theme {
  --color-acme-primary: #2856d8;
}
```

```tsx
<div className="[--codespring-agent-accent:var(--color-acme-primary)] [--codespring-agent-container-radius:18px]">
  <AgentProvider client={agentClient} appearance={acmeAppearance}>
    <AgentChat sessionId={sessionId} />
  </AgentProvider>
</div>
```

StyleX variables can be used as appearance values and themed from an ancestor:

```tsx
// agent-theme.stylex.ts
import * as stylex from "@stylexjs/stylex";

export const agentTokens = stylex.defineVars({ accent: "#3B6AC5" });
```

```tsx
import * as stylex from "@stylexjs/stylex";
import { agentTokens } from "./agent-theme.stylex";

const brandedTheme = stylex.createTheme(agentTokens, { accent: "#2856D8" });
const stylexAppearance = createAgentAppearance({
  theme: { accent: agentTokens.accent },
});

<div {...stylex.props(brandedTheme)}>
  <AgentProvider client={agentClient} appearance={stylexAppearance}>
    <AgentChat sessionId={sessionId} />
  </AgentProvider>
</div>;
```

## Headless React

Advanced clients can use `useAgentSession`, `useAgentMessages`,
`useAgentToolCalls`, `useAgentClient`, `useAgentTheme`, and `useAgentCopy` to
build a completely custom interface. The composable `AgentMessageList`,
`AgentMessage`, `AgentToolCall`, and `AgentComposer` primitives can also be
mixed with client-owned components.

The browser entrypoint never accepts an API key. A trusted application backend
must issue short-lived, origin-bound client tokens.

## Local showcase

```sh
bun run showcase
```

Open `http://127.0.0.1:5173` for the Paper UI or append `?theme=dark` for
the dark palette. The showcase uses mocked durable events and makes no
external API calls.

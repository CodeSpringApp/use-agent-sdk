# React agent UI

Import React APIs from `@codespring-app/use-agent/react`.

- Create one cached client with `createAgentClient({ endpoint, clientTokenEndpoint })`; the client deduplicates token requests and refreshes before expiry.
- Wrap the relevant UI subtree in `AgentProvider` and use the plug-and-play `Agent` component for the standard Ferb-inspired experience.
- Create stable appearance configuration with `createAgentAppearance` outside render or memoize it. Appearance uses CSS custom properties and works alongside Tailwind CSS or StyleX without requiring either.
- Use the exported hooks for fully custom UI while preserving the session/event lifecycle.
- Never embed a server API key or provider key in a browser bundle. The client-token endpoint belongs to the customer backend and returns a short-lived, origin-bound token.

Follow the host application's accessibility, responsive layout, and design-system conventions. Do not duplicate transport state in component-local fetch effects.

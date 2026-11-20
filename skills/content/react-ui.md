# React agent UI

Import React APIs from `@codespring-app/use-agent/react`.

- Create one cached client with `createAgentClient({ endpoint, clientTokenEndpoint })`; the client deduplicates token requests and refreshes before expiry.
- Wrap the relevant UI subtree in `AgentProvider` and use `AgentChat` for conversations or `AgentWorkspace` for an existing workspace session.
- Create stable appearance configuration with `createAgentAppearance` outside render or memoize it. Appearance uses CSS custom properties and works alongside Tailwind CSS or StyleX without requiring either.
- Use the exported hooks for fully custom UI while preserving the session/event lifecycle.
- Never embed a server API key or provider key in a browser bundle. The client-token endpoint belongs to the customer backend and returns a short-lived, origin-bound token.

Follow the host application's accessibility, responsive layout, and design-system conventions. Do not duplicate transport state in component-local fetch effects.

For workspace ownership, file limits, and availability checks, load `use-agent skills get workspace`. `useAgentWorkspace` provides file state for custom interfaces, while `AgentWorkspaceLayout` and `AgentWorkspaceFiles` provide composable UI.

For personal ChatGPT plan access, load `use-agent skills get workspace`. It is an exact-account internal pilot with separate OAuth setup. Check eligibility and connection status before offering it, keep the billing source explicit, and never fall back to API pricing after a plan error.

For the internal local-registration mode, initial consent uses the CLI on the browser computer. Subsequent API and SDK calls run on the server. The dashboard can refresh connection status after CLI consent; do not imply a hosted callback is available in this mode.

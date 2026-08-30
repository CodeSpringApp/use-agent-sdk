# Changelog

## 0.4.0 — 2026-08-30

- Add scoped, cursor-paginated agent and customer-tool management APIs to the
  server client.
- Ship the Node-only `@codespring-app/use-agent/cli` entrypoint and `use-agent`
  executable without affecting the root or React bundles.
- Add offline, digest-verified coding-agent skills and guarded installation for
  Codex, Claude, Cursor, Ferb, or an explicit destination.
- Add environment-only API-key authentication for headless inspection; secrets
  are not accepted as CLI arguments or persisted by the package.

## 0.3.0 — 2026-08-30

- Add versioned customer-hosted tools with `defineTool` and local execution.
- Add a Web-standard signed tool handler with exact body, audience, tenant,
  agent revision, tool revision, and handler revision verification.
- Require an execution store for replay and concurrent duplicate coordination;
  include an explicitly local in-memory implementation.
- Ensure `createAgent` retains only portable tool references and never embeds
  customer execution callbacks in an agent definition.

## 0.2.0 — 2026-08-30

- Add origin-bound, single-use browser WebSocket ticket exchange.
- Add durable multi-page replay and the public `AgentSession.connect` API.
- Add contiguous cursor tracking, replay/live deduplication, gap recovery, and
  reconnect state to the React session store.
- Align message and tool reducers with the canonical runtime event protocol.
- Add the reusable `AgentEventBuffer` and a production live-replay smoke.

## 0.1.0 — 2026-08-30

- Publish the initial public server and React SDK preview.

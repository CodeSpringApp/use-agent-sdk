# Changelog

## 0.9.0 — 2026-09-02

- Add namespaced MCP server discovery, refresh, status, and pagination APIs.
- Add versioned Markdown skill creation, publication, status, and pagination APIs.
- Allow managed agent drafts to select MCP tools and skills; published versions
  expose the exact pinned snapshot and skill revisions.

## 0.8.3 — 2026-09-02

- Add an adapter-level aggregate attachment byte limit and enforce it before
  upload/retry so multi-image turns stay within the runtime memory boundary.

## 0.8.2 — 2026-09-02

- Bind customer-owned attachment authorization to the exact opaque asset ID in
  addition to the request digest, tenant, environment, agent revision, and
  handler revision.

## 0.8.1 — 2026-09-02

- Allow the presentational `AgentThinkingIndicator` to render outside
  `AgentProvider`, while still inheriting provider theme and copy when present.

## 0.8.0 — 2026-09-01

- Add customer-owned, presigned attachment uploads with optimistic previews,
  paste/drop/picker input, retry, removal, and opaque asset references.
- Add a signed customer-hosted asset resolver handler; runtime requests are
  pinned to an immutable agent revision and never accept storage URLs in turns.
- Add an eight-line auto-growing composer without native resize chrome.
- Add customizable Ferb-style thinking verbs, shimmer, elapsed time, and a
  reduced-motion-safe four-point sparkle animation.

## 0.7.0 — 2026-08-31

- Add opt-in message copy, retry, binary feedback, and token-usage presentation
  with callback-driven privileged actions.
- Associate durable `usage.recorded` events with terminal assistant messages.

## 0.6.1 — 2026-08-31

- Preserve the required browser receiver when the SDK uses the global `fetch`
  implementation for client-token and runtime requests.

## 0.6.0 — 2026-08-31

- Replace the hand-written assistant Markdown parser with Streamdown for
  hardened, streaming-safe GFM.
- Export reusable `AgentMarkdown` and `AgentCodeBlock` primitives.
- Add lazy, fine-grained Shiki highlighting with immediate plain-code fallback,
  bounded caching, Paper themes, and reliable copy controls.
- Add public-neutral `AgentGenerativeUI` choice, multi-select, form, and review
  primitives with controlled pending/submitting/resolved state.
- Allow presentation-only components to render standalone while keeping client
  and durable-session hooks gated by `AgentProvider`.

## 0.5.0 — 2026-08-31

- Add RFC 8628 device authorization for interactive CLI login with explicit
  browser approval.
- Store refresh credentials only in macOS Keychain or Linux Secret Service and
  exchange them for short-lived, workspace- and environment-bound runtime tokens.
- Keep environment API keys as the non-interactive CI authentication method.

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

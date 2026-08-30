# Customer-hosted tools

Customer code runs on customer infrastructure. The hosted runtime stores only tool metadata and invokes a signed HTTPS handler.

- Define each tool with `defineTool`; keep its name, description, JSON input schema, risk, and handler revision aligned with the registered control-plane revision.
- Expose the handler with `createToolHandler`. Use its default CodeSpring JWKS verification unless a self-hosted deployment explicitly pins another trusted issuer/JWKS.
- Persist results by scoped operation ID for retries. Concurrent delivery of the same operation must join or replay the same result. A write tool must be intrinsically idempotent at the downstream system as well.
- Never log authorization headers, signed envelopes, provider credentials, or raw sensitive tool inputs/results.
- Deploy the handler first, verify its health route, then register the exact HTTPS endpoint and immutable handler revision. Keep old handler revisions available while published agents or durable sessions reference them.

Load the package example at `examples/customer-hosted-tool.ts` for the current handler API. Remote registration is a control-plane write and requires explicit authorization.

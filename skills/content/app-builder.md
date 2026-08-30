# Build a CodeSpring Agents application

Use the installed `@codespring-app/use-agent` package as the API source of truth.

1. Inspect the project, package version, existing server/client boundaries, and framework conventions.
2. Run `use-agent auth status --json`. If authentication is missing, ask the human to configure it; do not collect a credential in chat or place it in source.
3. Define immutable agent references with `createAgent({ id, revision })`. Runtime model routing uses reusable model IDs configured in the control plane, never raw provider/model credentials in application code.
4. Use `createClient` only in trusted server code. Issue short-lived browser client tokens on the server and use the React client from `@codespring-app/use-agent/react` in the browser.
5. For customer-hosted tools, load `use-agent skills get customer-tools`. For UI work, load `use-agent skills get react-ui`.
6. Test source changes locally. Remote registration or publication is a separate action and requires the user-selected workspace/environment and explicit authorization.
7. After publication, create one bounded smoke session and verify its event replay before reporting success.

Use `use-agent agents list --json` and `use-agent tools list --json` for supported control-plane inspection. Do not scrape the dashboard or query platform storage directly.

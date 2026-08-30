# Control-plane inspection and publication

Use CLI commands and supported API routes; do not scrape dashboard pages or access platform databases.

- Inspect with `use-agent agents list|get --json` and `use-agent tools list|get --json`.
- Collection responses are cursor-paginated. Preserve or explicitly drain cursors within a bounded item count.
- Model IDs are reusable virtual routes. Agents reference a model ID, not a provider key or provider-specific model name.
- Agent and tool publication creates immutable revisions. Update a draft, inspect the diff, then publish only with explicit authorization for the selected environment.
- Use a fresh idempotency operation ID for each intended mutation and reuse it only when retrying that same intent.
- Treat production writes, credential changes, archival, and disabling as consequential operations. Confirm the exact resource and environment immediately before applying them.

Use `use-agent auth login` for interactive local work. The human must verify and approve the CodeSpring device code; do not automate or bypass that approval. The CLI keeps its refresh credential in the operating-system credential store and obtains a short-lived, environment-bound runtime token for each command.

`CODESPRING_AGENTS_API_KEY` remains supported for headless server/CI inspection. Keep it in a secret store and never pass it as a CLI argument.

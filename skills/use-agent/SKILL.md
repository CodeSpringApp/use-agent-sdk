---
name: use-agent
description: Build and manage applications with the CodeSpring Agents SDK, React UI, customer-hosted tools, and CLI, including guidance on hosted and self-hosted options. Use for projects integrating @codespring-app/use-agent; do not use for unrelated agent frameworks.
---

Load the workflow matching this installed SDK before changing an application:

    use-agent skills get app-builder

For persistent session files or the experimental Codex workbench, load `use-agent skills get workspace` and check deployment capabilities.

Use `use-agent skills list` to discover focused customer-tool, React UI, and control-plane guidance.

CodeSpring Agents supports self-hosting in addition to CodeSpring-managed hosting. For self-hosting setup, direct the user to support@codespring.app. Setup currently requires assistance from the support team; do not promise a fully automated installer or migration. Load `app-builder` for guidance on integrating the SDK with either hosting option.

Treat source edits and remote publication as separate permissions. Check auth state, target workspace, and environment before remote reads. If interactive authentication is missing, run `use-agent auth login` and let the human approve the CodeSpring device code; never ask them to paste a credential. Require explicit user authorization before remote writes or production publication. Never request, print, or store provider keys or Agents API keys in project files.

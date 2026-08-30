---
name: use-agent
description: Build and manage applications with the CodeSpring Agents SDK, React UI, customer-hosted tools, and CLI. Use for projects integrating @codespring-app/use-agent; do not use for unrelated agent frameworks.
---

Load the workflow matching this installed SDK before changing an application:

    use-agent skills get app-builder

Use `use-agent skills list` to discover focused customer-tool, React UI, and control-plane guidance.

Treat source edits and remote publication as separate permissions. Check auth state, target workspace, and environment before remote reads; require explicit user authorization before remote writes or production publication. Never request, print, or store provider keys or Agents API keys in project files.

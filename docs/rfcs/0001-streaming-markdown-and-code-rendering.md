# RFC 0001: Streaming Markdown and reusable code rendering

- Status: Accepted for implementation
- Date: 2026-08-31
- Decision owners: CodeSpring Agents SDK and design-system teams

## Summary

`@codespring-app/use-agent/react` will replace its hand-written Markdown parser
with Streamdown and will export two reusable primitives:

```tsx
<AgentMarkdown streaming>{markdown}</AgentMarkdown>
<AgentCodeBlock code={source} language="typescript" />
```

Streamdown owns streaming-safe Markdown parsing, incomplete-block repair, GFM,
block memoization, and HTML/URL hardening. CodeSpring owns rendering and visual
components. Fenced code blocks use the same exported `AgentCodeBlock` as tool
arguments, generated artifacts, and standalone application content.

We will not use `@streamdown/code` as the default renderer. It is a capable
Shiki plugin, but its UI is intentionally coupled to Tailwind-generated utility
classes and shadcn-style variables. The Use Agent React SDK promises a
plug-and-play experience in vanilla CSS, Tailwind, StyleX, CSS Modules, and
other systems. `AgentCodeBlock` therefore uses Shiki's fine-grained modules and
JavaScript regex engine behind CodeSpring theme variables, with no required CSS
import or consumer build configuration.

## Context

The first Paper UI implemented a small parser for headings, bullets, quotes,
links, inline code, and fenced code. It does not correctly cover nested lists,
ordered lists, emphasis combinations, tables, task lists, footnotes, escaped
syntax, or incomplete Markdown while a model is streaming. Extending it would
create a bespoke Markdown implementation and a growing security surface.

Streamdown is designed for streamed model output. It repairs incomplete syntax,
memoizes blocks, supports GFM, hardens output, and allows element overrides. Its
code plugin includes Shiki highlighting and controls, but consumers must include
Streamdown/Tailwind sources and shadcn variables for the default styling. That
requirement conflicts with the SDK's existing inline/CSS-variable theme model.

Vercel Chatbot provides useful composition patterns:

- one memoized `MessageResponse` primitive for all model-authored text;
- a stable plugin object outside render functions;
- a separate reusable code block for tool JSON and non-Markdown content;
- immediate plain tokens while asynchronous highlighting loads;
- per-language highlighter caching and token caching; and
- message parts kept separate from transport and conversation scrolling.

We will adopt those boundaries without inheriting its Next.js, shadcn, Lucide,
Tailwind, or Vercel AI SDK dependencies.

## Goals

- Correctly render streamed and completed GFM from assistant messages.
- Make Markdown rendering reusable outside `AgentChat`.
- Make one themed code component reusable by Markdown, tool UIs, examples, and
  customer applications.
- Preserve readable server-rendered and loading fallbacks.
- Avoid requiring Tailwind content scanning, a global stylesheet, shadcn
  variables, or a framework-specific bundler.
- Keep the default bundle bounded with lazy language loading.
- Preserve the SDK's theme/copy overrides and advanced render hooks.
- Treat model Markdown as untrusted input.

## Non-goals

- Provide a general-purpose MDX or arbitrary HTML renderer.
- Enable Mermaid, math, remote images, or custom HTML tags by default.
- Ship an editor, diff viewer, notebook, or full code artifact runtime.
- Support every Shiki grammar in the initial fine-grained bundle.
- Replace customer-defined `renderMessage`, Markdown component overrides, or
  raw event hooks.
- Couple the SDK to Vercel AI SDK message types.

## Public API

### `AgentMarkdown`

```tsx
export interface AgentMarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
  style?: React.CSSProperties;
  theme?: Partial<AgentTheme>;
  components?: AgentMarkdownComponents;
}

<AgentMarkdown streaming={message.status === "streaming"}>
  {message.content}
</AgentMarkdown>
```

The component is usable inside `AgentProvider`. It inherits CodeSpring theme
variables, accepts per-instance theme overrides, and passes stable custom
component overrides into Streamdown. `AgentMessage` uses it for assistant text;
user text remains literal text.

Default behavior:

- Streamdown streaming mode when `streaming` is true, static mode otherwise;
- GFM enabled;
- incomplete Markdown repair enabled while streaming;
- raw HTML skipped;
- remote images omitted;
- links restricted by Streamdown's URL transform and rendered with
  `rel="noreferrer noopener"`;
- headings, paragraphs, lists, quotes, rules, tables, and inline code rendered
  with Paper styles; and
- fenced code delegated to `AgentCodeBlock`.

Advanced consumers may override individual Markdown elements. Replacing the
fenced-code renderer is explicit and does not affect the session protocol.

### `AgentCodeBlock`

```tsx
export interface AgentCodeBlockProps {
  code: string;
  language?: AgentCodeLanguage | string;
  filename?: string;
  showLineNumbers?: boolean;
  copy?: boolean;
  streaming?: boolean;
  className?: string;
  style?: React.CSSProperties;
  theme?: Partial<AgentTheme>;
}
```

The initial highlighted language set covers common web, systems, mobile, data,
and scripting languages. It includes TypeScript/TSX, JavaScript/JSX, JSON,
shell/Bash, HTML, CSS, Markdown, Python, Go, Rust, C/C++, C#, Java, Kotlin,
Swift, PHP, Ruby, SQL, YAML, and Dockerfiles. Unknown or incomplete language
identifiers render safely as plain text. Direct language modules load only when
used, rather than loading a full grammar registry or throwing during a partial
code fence.

The copy control is anchored at the top-right, reserves layout space, reports
`copied`/`copy failed`, supports keyboard focus, and falls back to a temporary
selection when the modern Clipboard API is blocked. It is disabled while its
code fence is incomplete.

## Rendering architecture

```text
durable message events
  -> reduceAgentMessages
  -> AgentMessage
  -> AgentMarkdown (Streamdown parser/security/stream repair)
  -> CodeSpring semantic component map
  -> AgentCodeBlock for fenced code
  -> fine-grained Shiki highlighter or immediate plain fallback
```

Transport, event reduction, Markdown parsing, and visual rendering stay
separate. `AgentMessageList` can continue memoizing and interleaving messages
with durable tool calls. Tool call JSON may use `AgentCodeBlock` directly
without serializing it into a Markdown fence.

## Shiki loading and caching

The SDK uses `shiki/core`, `shiki/engine/javascript`, direct theme modules, and
direct language modules. It does not import `shiki`, `shiki/bundle/web`, or the
full bundle from the React entrypoint.

One process-wide highlighter loads the light/dark themes once. Language loads
are deduplicated by canonical language ID. Token results use a bounded LRU cache
keyed by language, theme mode, and exact code content. The component:

1. renders plain code synchronously;
2. skips expensive highlighting for the currently incomplete streaming fence;
3. loads the requested supported grammar asynchronously;
4. ignores stale results after code/props change or unmount; and
5. falls back to plain code after any loader/highlighter error.

The initial HTML never disappears while highlighting loads. A lazy chunk
failure cannot remove the message or crash the conversation.

## Styling contract

Every element uses inline layout styles and existing
`--codespring-agent-*` variables. No global selector, utility-class extraction,
or mandatory CSS import is required. `className` remains available for
Tailwind/StyleX-compatible wrappers, and consumers may override variables on
any ancestor.

The appearance records its optional light/dark mode so the highlighter chooses
a matching token theme even when the OS preference differs from the application
theme. Existing hand-authored appearances default to light; appearances created
by `createAgentAppearance` receive the selected mode automatically.

## Security

Assistant Markdown is untrusted presentation data:

- raw HTML and custom tags are disabled by default;
- scripts, styles, event attributes, iframes, forms, and embedded objects never
  render;
- remote images do not load by default, avoiding tracking pixels;
- links use Streamdown URL sanitization and safe target/rel attributes;
- code is text, never evaluated;
- Shiki output is rendered as React token text rather than inserted as arbitrary
  HTML; and
- Markdown cannot create tools, approvals, client handlers, or runtime events.

Application-specific rich content belongs in explicit protocol items and render
slots, not magic Markdown tags.

## Dependency and packaging policy

`streamdown`, `shiki`, `@shikijs/langs`, and `@shikijs/themes` are runtime
dependencies of the React entrypoint. The server and CLI entrypoints must not
import React, Streamdown, Shiki, DOM APIs, or styles. Packaging tests import each
entrypoint independently and inspect the server bundle for those dependencies.

The package remains ESM and React remains a peer dependency. No stylesheet is
added to the root entrypoint. The README documents browser bundler notes and the
plain-text fallback.

## Testing

- Markdown unit fixtures cover partial bold, partial fences, ordered/nested
  lists, tables, task lists, blockquotes, safe links, rejected raw HTML, and
  unknown languages.
- Code tests cover immediate fallback, asynchronous highlighting, copy success,
  Clipboard fallback/failure, mode changes, and stale async results.
- SSR tests confirm readable semantic HTML without browser APIs.
- Package tests confirm root/CLI imports do not pull React/Streamdown/Shiki.
- The showcase includes streamed Markdown, a fenced TypeScript block, a table,
  and inline code in both Paper themes.
- Visual review checks long lines, horizontal scrolling, narrow containers,
  copy-control placement, and incomplete fences.

## Delivery

1. Add `AgentMarkdown` and `AgentCodeBlock` behind the existing React entrypoint.
2. Replace the private hand-written `AgentMarkdown` implementation.
3. Expand tests and the showcase.
4. Document standalone component usage and customization.
5. Release as a minor SDK version because the default assistant rendering gains
   features without changing session or server APIs.

## Decision

Adopt Streamdown as the Markdown engine and a CodeSpring-owned, Shiki-backed
`AgentCodeBlock` as the shared code renderer. Reuse the proven separation and
memoization patterns from Vercel Chatbot, while preserving the SDK's
framework-neutral, stylesheet-free design contract.

## References

- [Streamdown usage and streaming modes](https://streamdown.ai/docs/usage)
- [Streamdown component overrides](https://streamdown.ai/docs/components)
- [Streamdown code-block plugin](https://streamdown.ai/docs/plugins/code)
- [Vercel Chatbot reference application](https://github.com/vercel/chatbot)

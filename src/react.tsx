import {
  createContext,
  createElement,
  memo,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Streamdown,
  type Components as StreamdownComponents,
  useIsCodeFenceIncomplete,
} from "streamdown";
import {
  AgentError,
  createBrowserClient,
  type AgentClient,
  type AgentSession,
} from "./client";
import { AgentEventBuffer } from "./event-buffer";
import type {
  AgentConnection,
  AgentEvent,
  BrowserAgentClientOptions,
  SessionSnapshot,
  SubmitOptions,
  SubmitTurnResponse,
  ExternalAssetRef,
} from "./types";
import type { AgentAttachmentAdapter } from "./attachments";
import {
  highlightAgentCode,
  normalizeCodeLanguage,
  type AgentCodeLanguage,
  type HighlightedCode,
} from "./syntax-highlighter";

export interface AgentTheme {
  canvas: string;
  ink: string;
  inkSecondary: string;
  inkTertiary: string;
  well: string;
  hairline: string;
  statusGood: string;
  statusBad: string;
  statusWarn: string;
  accent: string;
  fontFamily: string;
  monoFamily: string;
  contentMaxWidth: number | string;
  containerRadius: number | string;
  wellRadius: number | string;
}

/** Stable CSS custom-property names supported by every default component. */
export const agentThemeVariables = Object.freeze({
  canvas: "--codespring-agent-canvas",
  ink: "--codespring-agent-ink",
  inkSecondary: "--codespring-agent-ink-secondary",
  inkTertiary: "--codespring-agent-ink-tertiary",
  well: "--codespring-agent-well",
  hairline: "--codespring-agent-hairline",
  statusGood: "--codespring-agent-status-good",
  statusBad: "--codespring-agent-status-bad",
  statusWarn: "--codespring-agent-status-warn",
  accent: "--codespring-agent-accent",
  fontFamily: "--codespring-agent-font-family",
  monoFamily: "--codespring-agent-mono-family",
  contentMaxWidth: "--codespring-agent-content-max-width",
  containerRadius: "--codespring-agent-container-radius",
  wellRadius: "--codespring-agent-well-radius",
} satisfies Record<keyof AgentTheme, `--${string}`>);

export interface AgentCopy {
  title: string;
  empty: string;
  loading: string;
  thinking: string;
  thinkingVerbs: readonly string[];
  placeholder: string;
  send: string;
  sending: string;
  failed: string;
  cancelled: string;
  userLabel: string;
  assistantLabel: string;
  toolRunning: string;
  toolCompleted: string;
  toolFailed: string;
  toolApprovalRequired: string;
}

export const paperLightTheme: Readonly<AgentTheme> = Object.freeze({
  canvas: "#FFFFFF",
  ink: "#141414",
  inkSecondary: "#68686D",
  inkTertiary: "#9B9BA0",
  well: "#F5F5F8",
  hairline: "#E4E4E8",
  statusGood: "#0E7B3F",
  statusBad: "#C33530",
  statusWarn: "#A06C02",
  accent: "#3B6AC5",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  monoFamily: "SFMono-Regular, SF Mono, ui-monospace, Menlo, Consolas, monospace",
  contentMaxWidth: 760,
  containerRadius: 10,
  wellRadius: 8,
});

export const paperDarkTheme: Readonly<AgentTheme> = Object.freeze({
  ...paperLightTheme,
  canvas: "#161618",
  ink: "#ECECEC",
  inkSecondary: "#98989D",
  inkTertiary: "#66666B",
  well: "#1D1D1F",
  hairline: "#29292C",
  statusGood: "#63C180",
  statusBad: "#DF5048",
  statusWarn: "#E3A648",
  accent: "#87B1FD",
});

export const defaultAgentCopy: Readonly<AgentCopy> = Object.freeze({
  title: "Assistant",
  empty: "Start a conversation",
  loading: "Loading conversation…",
  thinking: "Thinking",
  thinkingVerbs: Object.freeze([
    "Thinking",
    "Pondering",
    "Exploring",
    "Connecting",
    "Shaping",
    "Refining",
  ]),
  placeholder: "Message the agent",
  send: "Send message",
  sending: "Sending…",
  failed: "The agent could not complete this message.",
  cancelled: "This message was cancelled.",
  userLabel: "You",
  assistantLabel: "Assistant",
  toolRunning: "Running",
  toolCompleted: "Completed",
  toolFailed: "Failed",
  toolApprovalRequired: "Approval required",
});

export interface AgentAppearance {
  readonly mode?: "light" | "dark";
  readonly theme: Readonly<AgentTheme>;
  readonly copy: Readonly<AgentCopy>;
}

export interface CreateAgentAppearanceOptions {
  mode?: "light" | "dark";
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function createAgentAppearance({
  mode = "light",
  theme,
  copy,
}: CreateAgentAppearanceOptions = {}): AgentAppearance {
  return Object.freeze({
    mode,
    theme: Object.freeze({ ...(mode === "dark" ? paperDarkTheme : paperLightTheme), ...theme }),
    copy: Object.freeze({ ...defaultAgentCopy, ...copy }),
  });
}

export const paperAppearance = createAgentAppearance();
export const paperDarkAppearance = createAgentAppearance({ mode: "dark" });

function cssLength(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

function cssVariable(name: `--${string}`, fallback: string): string {
  return fallback === `var(${name})` || fallback.startsWith(`var(${name},`)
    ? fallback
    : `var(${name}, ${fallback})`;
}

function withThemeVariables(theme: AgentTheme): AgentTheme {
  return {
    canvas: cssVariable(agentThemeVariables.canvas, theme.canvas),
    ink: cssVariable(agentThemeVariables.ink, theme.ink),
    inkSecondary: cssVariable(agentThemeVariables.inkSecondary, theme.inkSecondary),
    inkTertiary: cssVariable(agentThemeVariables.inkTertiary, theme.inkTertiary),
    well: cssVariable(agentThemeVariables.well, theme.well),
    hairline: cssVariable(agentThemeVariables.hairline, theme.hairline),
    statusGood: cssVariable(agentThemeVariables.statusGood, theme.statusGood),
    statusBad: cssVariable(agentThemeVariables.statusBad, theme.statusBad),
    statusWarn: cssVariable(agentThemeVariables.statusWarn, theme.statusWarn),
    accent: cssVariable(agentThemeVariables.accent, theme.accent),
    fontFamily: cssVariable(agentThemeVariables.fontFamily, theme.fontFamily),
    monoFamily: cssVariable(agentThemeVariables.monoFamily, theme.monoFamily),
    contentMaxWidth: cssVariable(agentThemeVariables.contentMaxWidth, cssLength(theme.contentMaxWidth)),
    containerRadius: cssVariable(agentThemeVariables.containerRadius, cssLength(theme.containerRadius)),
    wellRadius: cssVariable(agentThemeVariables.wellRadius, cssLength(theme.wellRadius)),
  };
}

function withThemeOverrides(base: AgentTheme, overrides: Partial<AgentTheme> | undefined): AgentTheme {
  if (!overrides) return base;
  const resolvedOverrides = withThemeVariables({ ...paperLightTheme, ...overrides });
  const merged = { ...base } as Record<keyof AgentTheme, AgentTheme[keyof AgentTheme]>;
  for (const key of Object.keys(overrides) as Array<keyof AgentTheme>) {
    if (overrides[key] !== undefined) merged[key] = resolvedOverrides[key];
  }
  return merged as AgentTheme;
}

interface AgentContextValue {
  client: AgentClient;
  mode: "light" | "dark";
  theme: AgentTheme;
  copy: AgentCopy;
  stores: Map<string, SessionStore>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export interface AgentProviderProps extends PropsWithChildren {
  client: AgentClient;
  appearance?: AgentAppearance;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

function shallowEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function useStablePartial<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  const stable = useRef(value);
  if (!shallowEqual(stable.current ?? {}, value ?? {})) stable.current = value;
  return stable.current;
}

export function AgentProvider({
  client,
  appearance = paperAppearance,
  theme,
  copy,
  children,
}: AgentProviderProps) {
  const stableTheme = useStablePartial(theme);
  const stableCopy = useStablePartial(copy);
  const resolvedTheme = useMemo(
    () => Object.freeze(withThemeVariables({ ...appearance.theme, ...stableTheme })),
    [appearance.theme, stableTheme],
  );
  const resolvedCopy = useMemo(
    () => Object.freeze({ ...appearance.copy, ...stableCopy }),
    [appearance.copy, stableCopy],
  );
  const resolvedMode = appearance.mode ?? "light";
  const stores = useMemo(() => new Map<string, SessionStore>(), [client]);
  useEffect(() => () => {
    for (const store of stores.values()) store.dispose();
    stores.clear();
  }, [stores]);
  const value = useMemo(
    () => ({
      client,
      mode: resolvedMode,
      theme: resolvedTheme,
      copy: resolvedCopy,
      stores,
    }),
    [client, resolvedMode, resolvedTheme, resolvedCopy, stores],
  );
  return createElement(AgentContext.Provider, { value }, children);
}

function useAgentContext(): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) throw new Error("Agent React APIs must be used inside AgentProvider");
  return value;
}

function useOptionalAgentContext(): AgentContextValue | null {
  return useContext(AgentContext);
}

function usePresentationTheme(theme: Partial<AgentTheme> | undefined): {
  colors: AgentTheme;
  mode: "light" | "dark";
} {
  const context = useOptionalAgentContext();
  const base = context?.theme ?? withThemeVariables(paperAppearance.theme);
  return {
    colors: withThemeOverrides(base, theme),
    mode: context?.mode ?? paperAppearance.mode ?? "light",
  };
}

interface StyledProps {
  className?: string;
  style?: CSSProperties;
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // A secure browser context can still reject clipboard access by policy.
    }
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard is unavailable");
}

function tokenStyle(token: HighlightedCode["tokens"][number][number]): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    color: token.color,
    backgroundColor: token.bgColor,
    fontStyle: fontStyle & 1 ? "italic" : undefined,
    fontWeight: fontStyle & 2 ? 650 : undefined,
    textDecoration: fontStyle & 4 ? "underline" : undefined,
    ...(token.htmlStyle as CSSProperties | undefined),
  };
}

export interface AgentCodeBlockProps extends StyledProps {
  code: string;
  language?: AgentCodeLanguage | string;
  filename?: string;
  showLineNumbers?: boolean;
  copy?: boolean;
  streaming?: boolean;
  theme?: Partial<AgentTheme>;
}

/** A Paper-themed, async Shiki code block with a readable plain-text fallback. */
export function AgentCodeBlock({
  code,
  language,
  filename,
  showLineNumbers = false,
  copy = true,
  streaming = false,
  className,
  style,
  theme,
}: AgentCodeBlockProps) {
  const { colors, mode } = usePresentationTheme(theme);
  const fenceIncomplete = useIsCodeFenceIncomplete();
  const incomplete = streaming || fenceIncomplete;
  const canonicalLanguage = normalizeCodeLanguage(language);
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    setHighlighted(null);
    if (!incomplete && canonicalLanguage !== "text") {
      void highlightAgentCode(code, canonicalLanguage, mode).then((result) => {
        if (active) setHighlighted(result);
      });
    }
    return () => { active = false; };
  }, [canonicalLanguage, code, mode, incomplete]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const runCopy = async () => {
    try {
      await writeClipboard(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("idle"), 1_500);
  };

  const label = filename ?? language?.trim() ?? null;
  const hasHeader = Boolean(label || copy);
  const rawLines = code.split("\n");
  const lines = highlighted?.tokens ?? rawLines.map((line) => line ? [{ content: line, offset: 0 }] : []);

  return (
    <figure
      className={className}
      data-codespring-agent-code=""
      style={{
        position: "relative",
        margin: "9px 0",
        overflow: "hidden",
        border: `1px solid ${colors.hairline}`,
        borderRadius: colors.wellRadius,
        background: colors.well,
        color: colors.ink,
        ...style,
      }}
    >
      {label ? (
        <figcaption style={{ position: "absolute", top: 8, left: 12, zIndex: 1, color: colors.inkTertiary, fontFamily: colors.monoFamily, fontSize: 10 }}>
          {label}
        </figcaption>
      ) : null}
      {copy ? (
        <button
          type="button"
          disabled={incomplete}
          onClick={() => void runCopy()}
          aria-label={copyState === "idle" ? "Copy code" : copyState === "copied" ? "Code copied" : "Copy failed"}
          aria-live="polite"
          style={{
            position: "absolute",
            top: 6,
            right: 7,
            zIndex: 1,
            minWidth: 39,
            height: 22,
            padding: "0 6px",
            border: 0,
            borderRadius: 4,
            background: colors.well,
            color: colors.inkTertiary,
            cursor: incomplete ? "not-allowed" : "pointer",
            fontFamily: colors.monoFamily,
            fontSize: 10,
            opacity: incomplete ? 0.5 : 1,
          }}
        >
          {copyState === "copied" ? "copied" : copyState === "failed" ? "failed" : "copy"}
        </button>
      ) : null}
      <pre
        style={{
          margin: 0,
          padding: hasHeader ? "34px 12px 12px" : "12px",
          overflowX: "auto",
          fontFamily: colors.monoFamily,
          fontSize: 12,
          lineHeight: 1.55,
          tabSize: 2,
        }}
      >
        <code>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex} style={{ display: "flex", minHeight: "1.55em" }}>
              {showLineNumbers ? (
                <span aria-hidden="true" style={{ width: 30, marginRight: 12, flex: "0 0 auto", color: colors.inkTertiary, textAlign: "right", userSelect: "none" }}>
                  {lineIndex + 1}
                </span>
              ) : null}
              <span style={{ display: "block", minWidth: "max-content" }}>
                {line.length === 0
                  ? "\u00a0"
                  : line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={highlighted ? tokenStyle(token) : undefined}>{token.content}</span>
                  ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

export type AgentMarkdownComponents = StreamdownComponents;

export interface AgentMarkdownProps extends StyledProps {
  children: string;
  streaming?: boolean;
  theme?: Partial<AgentTheme>;
  components?: AgentMarkdownComponents;
}

/** Streaming-safe, hardened GFM rendering for model-authored text. */
export const AgentMarkdown = memo(function AgentMarkdown({
  children,
  streaming = false,
  className,
  style,
  theme,
  components: componentOverrides,
}: AgentMarkdownProps) {
  const { colors } = usePresentationTheme(theme);
  const components = useMemo<StreamdownComponents>(() => ({
    h1: ({ children: content }) => <h1 style={{ margin: "16px 0 7px", color: colors.ink, fontSize: 17, fontWeight: 650, lineHeight: 1.3 }}>{content}</h1>,
    h2: ({ children: content }) => <h2 style={{ margin: "15px 0 6px", color: colors.ink, fontSize: 15, fontWeight: 650, lineHeight: 1.35 }}>{content}</h2>,
    h3: ({ children: content }) => <h3 style={{ margin: "13px 0 5px", color: colors.ink, fontSize: 13, fontWeight: 650, lineHeight: 1.4 }}>{content}</h3>,
    h4: ({ children: content }) => <h4 style={{ margin: "12px 0 5px", color: colors.ink, fontSize: 13, fontWeight: 550 }}>{content}</h4>,
    p: ({ children: content }) => <p style={{ margin: "0 0 9px", whiteSpace: "pre-wrap" }}>{content}</p>,
    strong: ({ children: content }) => <strong style={{ fontWeight: 650 }}>{content}</strong>,
    em: ({ children: content }) => <em>{content}</em>,
    del: ({ children: content }) => <del style={{ color: colors.inkSecondary }}>{content}</del>,
    ul: ({ children: content }) => <ul style={{ margin: "7px 0 9px", paddingLeft: 20 }}>{content}</ul>,
    ol: ({ children: content }) => <ol style={{ margin: "7px 0 9px", paddingLeft: 22 }}>{content}</ol>,
    li: ({ children: content }) => <li style={{ margin: "3px 0", paddingLeft: 2 }}>{content}</li>,
    blockquote: ({ children: content }) => <blockquote style={{ margin: "9px 0", paddingLeft: 11, borderLeft: `2px solid ${colors.hairline}`, color: colors.inkSecondary }}>{content}</blockquote>,
    hr: () => <hr style={{ margin: "15px 0", border: 0, borderTop: `1px solid ${colors.hairline}` }} />,
    a: ({ children: content, href }) => <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: colors.accent, textDecorationThickness: 1, textUnderlineOffset: 2 }}>{content}</a>,
    inlineCode: ({ children: content }) => <code style={{ padding: "1px 4px", borderRadius: 4, background: colors.well, fontFamily: colors.monoFamily, fontSize: "0.92em" }}>{content}</code>,
    code: ({ children: content, className: codeClassName }) => {
      const language = typeof codeClassName === "string" ? codeClassName.replace(/^language-/u, "") : undefined;
      const code = String(content).replace(/\n$/u, "");
      return <AgentCodeBlock code={code} {...(language === undefined ? {} : { language })} {...(theme === undefined ? {} : { theme })} />;
    },
    table: ({ children: content }) => <div style={{ margin: "10px 0", overflowX: "auto", border: `1px solid ${colors.hairline}`, borderRadius: colors.wellRadius }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>{content}</table></div>,
    th: ({ children: content }) => <th style={{ padding: "7px 9px", borderBottom: `1px solid ${colors.hairline}`, background: colors.well, color: colors.inkSecondary, fontWeight: 650, textAlign: "left" }}>{content}</th>,
    td: ({ children: content }) => <td style={{ padding: "7px 9px", borderBottom: `1px solid ${colors.hairline}`, verticalAlign: "top" }}>{content}</td>,
    input: ({ checked, type }) => type === "checkbox" ? <input type="checkbox" checked={checked} readOnly tabIndex={-1} style={{ width: 16, height: 16, flex: "0 0 16px", margin: "0 6px 0 0", accentColor: colors.accent }} /> : null,
    img: () => null,
    ...componentOverrides,
  }), [colors, componentOverrides, theme]);

  return (
    <div className={className} style={{ color: colors.ink, overflowWrap: "anywhere", ...style }}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        parseIncompleteMarkdown={streaming}
        components={components}
        controls={false}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
        skipHtml
        disallowedElements={["img"]}
        dir="auto"
      >
        {children}
      </Streamdown>
    </div>
  );
});

export interface AgentUIOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentUIField {
  id: string;
  label: string;
  value: string;
  description?: string;
  format?: "text" | "slug" | "multiline";
  required?: boolean;
}

interface AgentUIRequestBase {
  requestId: string;
  title: string;
  description?: string;
  submitLabel?: string;
}

export type AgentUIRequest =
  | (AgentUIRequestBase & {
      kind: "choice";
      options: AgentUIOption[];
    })
  | (AgentUIRequestBase & {
      kind: "multi_select";
      options: AgentUIOption[];
      minimum?: number;
      maximum?: number;
    })
  | (AgentUIRequestBase & {
      kind: "form";
      fields: AgentUIField[];
    })
  | (AgentUIRequestBase & {
      kind: "review";
      items: Array<{ id: string; label: string; value: string }>;
    });

export type AgentUIResponse =
  | { requestId: string; kind: "choice"; value: string }
  | { requestId: string; kind: "multi_select"; value: string[] }
  | { requestId: string; kind: "form"; value: Record<string, string> }
  | { requestId: string; kind: "review"; value: "approved" };

export type AgentUIState = "pending" | "submitting" | "resolved";

export interface AgentUIRendererProps {
  request: AgentUIRequest;
  state: AgentUIState;
  response?: AgentUIResponse;
  disabled: boolean;
  submit: (response: AgentUIResponse) => void;
}

export type AgentUIRenderers = Partial<Record<
  AgentUIRequest["kind"],
  (props: AgentUIRendererProps) => ReactNode
>>;

export interface AgentGenerativeUIProps extends StyledProps {
  request: AgentUIRequest;
  state?: AgentUIState;
  response?: AgentUIResponse;
  error?: string;
  disabled?: boolean;
  theme?: Partial<AgentTheme>;
  renderers?: AgentUIRenderers;
  onSubmit: (response: AgentUIResponse) => void | Promise<void>;
}

/**
 * Renders a bounded, declarative human-input request selected by an agent.
 * It never evaluates model-authored code, HTML, styles, URLs, or handlers.
 */
export function AgentGenerativeUI({
  request,
  state = "pending",
  response,
  error,
  disabled = false,
  theme,
  renderers,
  onSubmit,
  className,
  style,
}: AgentGenerativeUIProps) {
  const { colors } = usePresentationTheme(theme);
  const inactive = disabled || state !== "pending";
  const submit = (next: AgentUIResponse) => {
    if (!inactive) void onSubmit(next);
  };
  const custom = renderers?.[request.kind];
  const controlProps: AgentUIRendererProps = {
    request,
    state,
    ...(response === undefined ? {} : { response }),
    disabled: inactive,
    submit,
  };

  return (
    <section
      className={className}
      data-codespring-agent-ui={request.kind}
      aria-labelledby={`agent-ui-${request.requestId}`}
      style={{
        overflow: "hidden",
        border: `1px solid ${colors.hairline}`,
        borderRadius: colors.containerRadius,
        background: colors.canvas,
        color: colors.ink,
        ...style,
      }}
    >
      <header style={{ padding: "12px 14px 10px", borderBottom: `1px solid ${colors.hairline}` }}>
        <h3 id={`agent-ui-${request.requestId}`} style={{ margin: 0, fontSize: 13, fontWeight: 650, lineHeight: 1.4 }}>
          {request.title}
        </h3>
        {request.description ? (
          <p style={{ margin: "4px 0 0", color: colors.inkSecondary, fontSize: 12, lineHeight: 1.5 }}>
            {request.description}
          </p>
        ) : null}
      </header>
      <div style={{ padding: 10 }}>
        {custom ? custom(controlProps) : (
          <DefaultAgentUIControl
            {...controlProps}
            colors={colors}
          />
        )}
        {state === "resolved" ? (
          <p role="status" style={{ margin: "9px 4px 1px", color: colors.statusGood, fontSize: 11 }}>
            Response recorded
          </p>
        ) : null}
        {error ? (
          <p role="alert" style={{ margin: "9px 4px 1px", color: colors.statusBad, fontSize: 11 }}>
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function DefaultAgentUIControl(props: AgentUIRendererProps & { colors: AgentTheme }) {
  switch (props.request.kind) {
    case "choice":
      return <ChoiceAgentUI {...props} request={props.request}/>;
    case "multi_select":
      return <MultiSelectAgentUI {...props} request={props.request}/>;
    case "form":
      return <FormAgentUI {...props} request={props.request}/>;
    case "review":
      return <ReviewAgentUI {...props} request={props.request}/>;
  }
}

type ControlProps<T extends AgentUIRequest> = Omit<AgentUIRendererProps, "request"> & {
  request: T;
  colors: AgentTheme;
};

function actionStyle(colors: AgentTheme, primary = false): CSSProperties {
  return {
    minHeight: 30,
    padding: "5px 10px",
    border: `1px solid ${primary ? colors.ink : colors.hairline}`,
    borderRadius: 7,
    background: primary ? colors.ink : "transparent",
    color: primary ? colors.canvas : colors.ink,
    font: `500 12px/1.4 ${colors.fontFamily}`,
    cursor: "pointer",
  };
}

function ChoiceAgentUI({ request, response, disabled, submit, colors }: ControlProps<Extract<AgentUIRequest, { kind: "choice" }>>) {
  const selected = response?.kind === "choice" ? response.value : null;
  return <div style={{ display: "grid", gap: 3 }}>
    {request.options.map((option) => (
      <button
        key={option.id}
        type="button"
        disabled={disabled}
        onClick={() => submit({ requestId: request.requestId, kind: "choice", value: option.id })}
        aria-pressed={selected === option.id}
        style={{ ...actionStyle(colors), padding: "8px 10px", textAlign: "left", background: selected === option.id ? colors.well : "transparent", opacity: disabled && selected !== option.id ? 0.5 : 1 }}
      >
        <span style={{ display: "block", fontWeight: 600 }}>{option.label}</span>
        {option.description ? <span style={{ display: "block", marginTop: 2, color: colors.inkTertiary, fontSize: 11 }}>{option.description}</span> : null}
      </button>
    ))}
  </div>;
}

function MultiSelectAgentUI({ request, response, disabled, submit, colors }: ControlProps<Extract<AgentUIRequest, { kind: "multi_select" }>>) {
  const resolvedValues = response?.kind === "multi_select" ? response.value : [];
  const [selected, setSelected] = useState<string[]>(resolvedValues);
  useEffect(() => setSelected(resolvedValues), [request.requestId, response]);
  const minimum = request.minimum ?? 0;
  const maximum = request.maximum ?? request.options.length;
  return <div>
    <div style={{ display: "grid", gap: 3 }}>
      {request.options.map((option) => {
        const checked = selected.includes(option.id);
        return <label key={option.id} style={{ display: "flex", alignItems: "flex-start", minHeight: 36, gap: 8, padding: "7px 9px", borderRadius: 7, color: disabled ? colors.inkTertiary : colors.ink, cursor: disabled ? "default" : "pointer" }}>
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled || (!checked && selected.length >= maximum)}
            onChange={() => setSelected((current) => checked ? current.filter((id) => id !== option.id) : [...current, option.id])}
            style={{ width: 16, height: 16, flex: "0 0 16px", margin: "2px 0 0", accentColor: colors.accent }}
          />
          <span style={{ minWidth: 0 }}><span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{option.label}</span>{option.description ? <span style={{ display: "block", color: colors.inkTertiary, fontSize: 11, overflowWrap: "anywhere" }}>{option.description}</span> : null}</span>
        </label>;
      })}
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 9 }}>
      <button type="button" disabled={disabled || selected.length < minimum} onClick={() => submit({ requestId: request.requestId, kind: "multi_select", value: selected })} style={{ ...actionStyle(colors, true), opacity: disabled || selected.length < minimum ? 0.45 : 1 }}>
        {request.submitLabel ?? "Continue"}
      </button>
    </div>
  </div>;
}

function FormAgentUI({ request, response, disabled, submit, colors }: ControlProps<Extract<AgentUIRequest, { kind: "form" }>>) {
  const initialValues = response?.kind === "form"
    ? response.value
    : Object.fromEntries(request.fields.map((field) => [field.id, field.value]));
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  useEffect(() => setValues(initialValues), [request, response]);
  const valid = request.fields.every((field) => !field.required || values[field.id]?.trim());
  const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 4, padding: "7px 9px", border: `1px solid ${colors.hairline}`, borderRadius: 7, background: colors.well, color: colors.ink, font: `400 12px/1.5 ${colors.fontFamily}` };
  return <form onSubmit={(event) => { event.preventDefault(); if (valid) submit({ requestId: request.requestId, kind: "form", value: values }); }}>
    <div style={{ display: "grid", gap: 10 }}>
      {request.fields.map((field) => <label key={field.id} style={{ color: colors.inkSecondary, fontSize: 11 }}>
        {field.label}
        {field.format === "multiline"
          ? <textarea disabled={disabled} required={field.required} value={values[field.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} rows={3} style={{ ...inputStyle, resize: "vertical", fontFamily: colors.fontFamily }}/>
          : (
              <input disabled={disabled} required={field.required} value={values[field.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} style={{ ...inputStyle, fontFamily: field.format === "slug" ? colors.monoFamily : colors.fontFamily }}/>
            )}
        {field.description ? <span style={{ display: "block", marginTop: 3, color: colors.inkTertiary }}>{field.description}</span> : null}
      </label>)}
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
      <button type="submit" disabled={disabled || !valid} style={{ ...actionStyle(colors, true), opacity: disabled || !valid ? 0.45 : 1 }}>{request.submitLabel ?? "Continue"}</button>
    </div>
  </form>;
}

function ReviewAgentUI({ request, disabled, submit, colors }: ControlProps<Extract<AgentUIRequest, { kind: "review" }>>) {
  return <div>
    <dl style={{ display: "grid", gap: 7, margin: 0 }}>
      {request.items.map((item) => <div key={item.id} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 0.4fr) minmax(0, 1fr)", gap: 10 }}><dt style={{ color: colors.inkTertiary, fontSize: 11 }}>{item.label}</dt><dd style={{ margin: 0, color: colors.ink, fontSize: 12, overflowWrap: "anywhere" }}>{item.value}</dd></div>)}
    </dl>
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10, paddingTop: 9, borderTop: `1px solid ${colors.hairline}` }}>
      <button type="button" disabled={disabled} onClick={() => submit({ requestId: request.requestId, kind: "review", value: "approved" })} style={{ ...actionStyle(colors, true), opacity: disabled ? 0.45 : 1 }}>{request.submitLabel ?? "Confirm"}</button>
    </div>
  </div>;
}


export function useAgentClient(): AgentClient {
  return useAgentContext().client;
}

export interface CreateAgentClientOptions {
  endpoint: string;
  clientTokenEndpoint: string;
  fetch?: BrowserAgentClientOptions["fetch"];
  credentials?: RequestCredentials;
  clientTokenTtlMs?: number;
  refreshSkewMs?: number;
  webSocket?: BrowserAgentClientOptions["webSocket"];
}

/** Creates one stable browser client with an in-memory, deduplicated client-token cache. */
export function createAgentClient({
  endpoint,
  clientTokenEndpoint,
  fetch: fetchImplementation,
  credentials = "same-origin",
  clientTokenTtlMs,
  refreshSkewMs,
  webSocket,
}: CreateAgentClientOptions): AgentClient {
  return createBrowserClient({
    endpoint,
    getClientToken: async () => {
      const request = fetchImplementation ?? globalThis.fetch?.bind(globalThis);
      if (!request) throw new TypeError("A fetch implementation is required");
      const response = await request(clientTokenEndpoint, {
        method: "POST",
        credentials,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Client token request failed with ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) return response.text();
      const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
      if (typeof body.token !== "string") throw new Error("Client token response is missing token");
      return {
        token: body.token,
        ...(typeof body.expiresAt === "string" || typeof body.expiresAt === "number"
          ? { expiresAt: body.expiresAt }
          : {}),
      };
    },
    ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
    ...(clientTokenTtlMs === undefined ? {} : { clientTokenTtlMs }),
    ...(refreshSkewMs === undefined ? {} : { refreshSkewMs }),
    ...(webSocket === undefined ? {} : { webSocket }),
  });
}

export function useAgentTheme(): AgentTheme {
  return useAgentContext().theme;
}

export function useAgentCopy(): AgentCopy {
  return useAgentContext().copy;
}

export type AgentMessageStatus = "completed" | "streaming" | "failed" | "cancelled";

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface AgentChatMessage {
  id: string;
  turnId: string;
  attempt: number;
  role: "user" | "assistant";
  content: string;
  status: AgentMessageStatus;
  createdAt: string;
  eventId: number;
  usage?: AgentTokenUsage;
}

export type AgentFeedbackValue = "positive" | "negative";

export interface AgentMessageActionConfig {
  retry?: "failed" | "always" | false;
  feedback?: "binary" | false;
  copy?: boolean;
  usage?: "tokens" | false;
}

export type AgentToolCallStatus =
  | "proposed"
  | "running"
  | "completed"
  | "failed"
  | "approval_required";

export interface AgentToolCall {
  id: string;
  turnId: string;
  operationId?: string;
  callId?: string;
  revision?: string;
  risk?: string;
  name: string;
  label: string;
  summary?: string;
  status: AgentToolCallStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  createdAt: string;
  eventId: number;
}

function stringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function unknownField(data: unknown, key: string): unknown {
  if (!data || typeof data !== "object") return undefined;
  return (data as Record<string, unknown>)[key];
}

function numberField(data: unknown, key: string): number {
  if (!data || typeof data !== "object") return 0;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** Pure reducer for consumers that want CodeSpring's durable event semantics with custom UI. */
export function reduceAgentMessages(events: readonly AgentEvent[]): AgentChatMessage[] {
  const messages = new Map<string, AgentChatMessage>();

  for (const event of events) {
    if (!event.turnId) continue;
    const inputId = `${event.turnId}:user`;
    const itemId = stringField(event.data, "itemId");
    const outputId = `${event.turnId}:assistant:${itemId ?? `attempt-${event.attempt}`}`;

    if (event.type === "message.input") {
      messages.set(inputId, {
        id: inputId,
        turnId: event.turnId,
        attempt: event.attempt,
        role: "user",
        content: stringField(event.data, "content") ?? "",
        status: "completed",
        createdAt: event.createdAt,
        eventId: event.id,
      });
      continue;
    }

    if (event.type === "message.started") {
      messages.set(outputId, {
        id: outputId,
        turnId: event.turnId,
        attempt: event.attempt,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: event.createdAt,
        eventId: event.id,
      });
      continue;
    }

    if (event.type === "message.delta") {
      const current = messages.get(outputId);
      if (current) {
        messages.set(outputId, {
          ...current,
          content: current.content + (stringField(event.data, "delta") ?? ""),
          eventId: event.id,
        });
      }
      continue;
    }

    if (event.type === "message.completed") {
      const current = messages.get(outputId);
      messages.set(outputId, {
        id: outputId,
        turnId: event.turnId,
        attempt: event.attempt,
        role: "assistant",
        content: stringField(event.data, "content") ?? current?.content ?? "",
        status: "completed",
        createdAt: current?.createdAt ?? event.createdAt,
        eventId: event.id,
      });
      continue;
    }

    if (event.type === "message.attempt_abandoned") {
      for (const [id, message] of messages) {
        if (
          message.turnId === event.turnId &&
          message.role === "assistant" &&
          message.attempt === event.attempt &&
          message.status === "streaming"
        ) {
          messages.delete(id);
        }
      }
      continue;
    }

    if (event.type === "usage.recorded") {
      const inputTokens = numberField(event.data, "inputTokens");
      const outputTokens = numberField(event.data, "outputTokens");
      const usage: AgentTokenUsage = {
        inputTokens,
        outputTokens,
        cachedInputTokens: numberField(event.data, "cachedInputTokens"),
        reasoningTokens: numberField(event.data, "reasoningTokens"),
        totalTokens: inputTokens + outputTokens,
      };
      const current = [...messages.values()]
        .filter((message) =>
          message.turnId === event.turnId &&
          message.role === "assistant" &&
          message.attempt === event.attempt
        )
        .at(-1);
      if (current) messages.set(current.id, { ...current, usage, eventId: event.id });
      continue;
    }

    if (event.type === "turn.failed" || event.type === "turn.cancelled") {
      const current = [...messages.values()]
        .filter((message) => message.turnId === event.turnId && message.role === "assistant" && message.attempt === event.attempt)
        .at(-1);
      const terminalId = current?.id ?? `${event.turnId}:assistant:${event.attempt}`;
      messages.set(terminalId, {
        id: terminalId,
        turnId: event.turnId,
        attempt: event.attempt,
        role: "assistant",
        content: current?.content ?? "",
        status: event.type === "turn.failed" ? "failed" : "cancelled",
        createdAt: current?.createdAt ?? event.createdAt,
        eventId: event.id,
      });
    }
  }

  return [...messages.values()].sort((left, right) => left.eventId - right.eventId);
}

/** Pure reducer for durable server, MCP, and client tool activity. */
export function reduceAgentToolCalls(events: readonly AgentEvent[]): AgentToolCall[] {
  const calls = new Map<string, AgentToolCall>();

  for (const event of events) {
    if (!event.turnId) continue;
    const lifecycle = toolLifecycle(event.type);
    if (!lifecycle) continue;
    const operationId = stringField(event.data, "operationId");
    const callId = stringField(event.data, "callId") ?? stringField(event.data, "toolCallId");
    const eventName = stringField(event.data, "toolName") ?? stringField(event.data, "name");
    const revision = stringField(event.data, "toolRevision");
    const risk = stringField(event.data, "risk");
    const id = operationId ?? callId ?? `${event.turnId}:${event.attempt}:${eventName ?? "tool"}`;
    const current = calls.get(id);
    const name = eventName ?? current?.name ?? "tool";
    const summary = stringField(event.data, "summary");
    const status: AgentToolCallStatus =
      lifecycle === "completed"
        ? "completed"
        : lifecycle === "failed"
          ? "failed"
          : lifecycle === "approval_required" || (lifecycle === "proposed" && stringField(event.data, "approval") === "required")
            ? "approval_required"
            : lifecycle === "started"
              ? "running"
              : "proposed";
    const input = unknownField(event.data, "arguments") ?? unknownField(event.data, "input");
    const output = unknownField(event.data, "output");
    const failure = unknownField(event.data, "error");

    calls.set(id, {
      id,
      turnId: event.turnId,
      ...(operationId === undefined ? current?.operationId === undefined ? {} : { operationId: current.operationId } : { operationId }),
      ...(callId === undefined ? current?.callId === undefined ? {} : { callId: current.callId } : { callId }),
      ...(revision === undefined ? current?.revision === undefined ? {} : { revision: current.revision } : { revision }),
      ...(risk === undefined ? current?.risk === undefined ? {} : { risk: current.risk } : { risk }),
      name,
      label: stringField(event.data, "label") ?? current?.label ?? name,
      ...(summary === undefined
        ? current?.summary === undefined
          ? {}
          : { summary: current.summary }
        : { summary }),
      status,
      ...(input === undefined
        ? current?.input === undefined
          ? {}
          : { input: current.input }
        : { input }),
      ...(output === undefined
        ? current?.output === undefined
          ? {}
          : { output: current.output }
        : { output }),
      ...(failure === undefined
        ? current?.error === undefined
          ? {}
          : { error: current.error }
        : { error: failure }),
      createdAt: current?.createdAt ?? event.createdAt,
      eventId: event.id,
    });
  }

  return [...calls.values()].sort((left, right) => left.eventId - right.eventId);
}

function toolLifecycle(type: string): "proposed" | "started" | "completed" | "failed" | "approval_required" | null {
  const canonical = /^(?:tool|tool\.call)\.(proposed|started|completed|failed|approval_required)$/u.exec(type)?.[1];
  return canonical === "proposed" || canonical === "started" || canonical === "completed" || canonical === "failed" || canonical === "approval_required"
    ? canonical
    : null;
}

interface SessionState {
  status: "idle" | "loading" | "ready" | "error";
  connection: "idle" | "connecting" | "live" | "reconnecting" | "closed";
  snapshot: SessionSnapshot | null;
  events: AgentEvent[];
  messages: AgentChatMessage[];
  toolCalls: AgentToolCall[];
  error: Error | null;
}

const initialSessionState: SessionState = {
  status: "idle",
  connection: "idle",
  snapshot: null,
  events: [],
  messages: [],
  toolCalls: [],
  error: null,
};

class SessionStore {
  private state: SessionState = initialSessionState;
  private readonly listeners = new Set<() => void>();
  private readonly eventBuffer = new AgentEventBuffer();
  private controller: AbortController | null = null;
  private connection: AgentConnection | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reconnectAttempt = 0;

  constructor(readonly session: AgentSession) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  };

  getSnapshot = () => this.state;
  getServerSnapshot = () => initialSessionState;

  private setState(state: SessionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  async refresh() {
    const generation = ++this.generation;
    this.controller?.abort();
    this.connection?.close(1000, "refreshing");
    this.connection = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.setState({
      ...this.state,
      status: this.state.snapshot ? "ready" : "loading",
      connection: "connecting",
      error: null,
    });
    try {
      const snapshot = await this.session.get({ signal });
      if (snapshot.cursor < this.eventBuffer.cursor) this.eventBuffer.reset();
      await this.replayDurableEvents(signal);
      if (signal.aborted || generation !== this.generation) return;
      this.publishBuffer(snapshot, "connecting");
      await this.openLiveConnection(generation, signal);
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      this.scheduleReconnect(error);
    }
  }

  private async replayDurableEvents(signal: AbortSignal): Promise<void> {
    let cursor = this.eventBuffer.cursor;
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < 100) {
        const page = await this.session.events(cursor, 100, { signal });
      const merged = this.eventBuffer.merge(page.events);
      if (merged.gap) {
        throw new AgentError(
          `Durable event gap: expected ${merged.gap.expected}, received ${merged.gap.received}`,
          0,
          "event_gap",
        );
      }
      if (page.hasMore && page.cursor <= cursor) {
        throw new AgentError("Durable replay did not advance", 0, "replay_stalled");
      }
      cursor = this.eventBuffer.cursor;
        hasMore = page.hasMore;
        pages += 1;
      }
    if (hasMore) {
      throw new AgentError(
        "Conversation history exceeds the current 10,000-event UI limit",
        0,
        "history_limit_exceeded",
      );
    }
  }

  private async openLiveConnection(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const connection = await this.session.connect({
      after: this.eventBuffer.cursor,
      signal,
      onEvent: (event) => this.receiveLiveEvent(event, generation),
      onReplayComplete: (cursor) => {
        if (generation !== this.generation || signal.aborted) return;
        if (cursor > this.eventBuffer.cursor) {
          const active = this.connection;
          this.connection = null;
          active?.close(1012, "repairing event gap");
          this.scheduleReconnect(
            new AgentError("Live replay ended ahead of the local cursor", 0, "event_gap"),
            true,
          );
          return;
        }
        this.reconnectAttempt = 0;
        this.setState({ ...this.state, connection: "live", error: null });
      },
      onError: (error) => {
        if (generation === this.generation && !signal.aborted) {
          this.setState({ ...this.state, error });
        }
      },
      onClose: () => {
        if (
          generation === this.generation &&
          !signal.aborted &&
          this.connection !== null
        ) {
          this.connection = null;
          this.scheduleReconnect(
            new AgentError("Live connection closed", 0, "websocket_closed"),
          );
        }
      },
    });
    if (signal.aborted || generation !== this.generation) {
      connection.close(1000, "stale connection");
      return;
    }
    this.connection = connection;
  }

  private receiveLiveEvent(event: AgentEvent, generation: number): void {
    if (generation !== this.generation) return;
    if (event.sessionId !== this.session.id) {
      const active = this.connection;
      this.connection = null;
      active?.close(1008, "wrong session event");
      this.setState({
        ...this.state,
        status: "error",
        connection: "closed",
        error: new AgentError("Runtime returned an event for another session", 0, "invalid_event"),
      });
      return;
    }
    const merged = this.eventBuffer.merge([event]);
    const snapshot = merged.accepted.reduce(
      (current, accepted) => applyEventToSnapshot(current, accepted),
      this.state.snapshot,
    );
    this.publishBuffer(snapshot, this.state.connection);
    if (merged.gap) {
      const active = this.connection;
      this.connection = null;
      active?.close(1012, "repairing event gap");
      this.scheduleReconnect(
        new AgentError(
          `Live event gap: expected ${merged.gap.expected}, received ${merged.gap.received}`,
          0,
          "event_gap",
        ),
        true,
      );
    }
  }

  private publishBuffer(
    snapshot: SessionSnapshot | null,
    connection: SessionState["connection"],
  ): void {
    const events = [...this.eventBuffer.events];
    this.setState({
      status: snapshot ? "ready" : this.state.status,
      connection,
      snapshot,
      events,
      messages: reduceAgentMessages(events),
      toolCalls: reduceAgentToolCalls(events),
      error: null,
    });
  }

  private scheduleReconnect(error: unknown, immediate = false): void {
    if (this.listeners.size === 0) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (isPermanentConnectionError(normalized)) {
      this.setState({
        ...this.state,
        status: "error",
        connection: "closed",
        error: normalized,
      });
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const exponent = Math.min(this.reconnectAttempt, 5);
    const delay = immediate
      ? 0
      : Math.round(Math.min(10_000, 400 * 2 ** exponent) * (0.75 + Math.random() * 0.5));
    this.reconnectAttempt += 1;
    this.setState({
      ...this.state,
      status: this.state.snapshot ? "ready" : "error",
      connection: "reconnecting",
      error: this.state.snapshot ? null : normalized,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refresh();
    }, delay);
  }

  private stop(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.connection?.close(1000, "no subscribers");
    this.connection = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  dispose() {
    this.stop();
  }
}

function isPermanentConnectionError(error: Error): boolean {
  return (
    error instanceof AgentError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function applyEventToSnapshot(
  snapshot: SessionSnapshot | null,
  event: AgentEvent,
): SessionSnapshot | null {
  if (!snapshot) return null;
  const status = turnStatusForEvent(event.type);
  if (!status || !event.turnId) {
    return event.id > snapshot.cursor ? { ...snapshot, cursor: event.id } : snapshot;
  }
  const existing = snapshot.turns.find((turn) => turn.id === event.turnId);
  const turn = {
    id: event.turnId,
    status,
    attempt: event.attempt,
    createdAt: existing?.createdAt ?? event.createdAt,
    updatedAt: event.createdAt,
  };
  return {
    ...snapshot,
    updatedAt: event.createdAt,
    cursor: Math.max(snapshot.cursor, event.id),
    turns: existing
      ? snapshot.turns.map((candidate) =>
          candidate.id === event.turnId ? turn : candidate,
        )
      : [...snapshot.turns, turn],
  };
}

function turnStatusForEvent(type: string): SessionSnapshot["turns"][number]["status"] | null {
  if (type === "turn.queued") return "queued";
  if (type === "turn.started") return "running";
  if (type === "turn.completed") return "completed";
  if (type === "turn.failed") return "failed";
  if (type === "turn.cancelled") return "cancelled";
  return null;
}

export interface AgentSessionResult extends SessionState {
  session: AgentSession;
  refresh: () => Promise<void>;
  submit: (content: string, options?: SubmitOptions) => Promise<SubmitTurnResponse>;
  cancel: (turnId: string) => Promise<void>;
}

export function useAgentSession(sessionId: string): AgentSessionResult {
  const context = useAgentContext();
  const store = useMemo(() => {
    const existing = context.stores.get(sessionId);
    if (existing) return existing;
    const created = new SessionStore(context.client.sessions.get(sessionId));
    context.stores.set(sessionId, created);
    return created;
  }, [context.client, context.stores, sessionId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  return {
    ...state,
    session: store.session,
    refresh: () => store.refresh(),
    submit: async (content, options) => {
      const result = await store.session.submit(content, options);
      await store.refresh();
      return result;
    },
    cancel: async (turnId) => {
      await store.session.cancel(turnId);
      await store.refresh();
    },
  };
}

export function useAgentMessages(sessionId: string): AgentChatMessage[] {
  return useAgentSession(sessionId).messages;
}

export function useAgentToolCalls(sessionId: string): AgentToolCall[] {
  return useAgentSession(sessionId).toolCalls;
}

export interface AgentMessageProps extends StyledProps {
  message: AgentChatMessage;
  actions?: AgentMessageActionConfig;
  onRetry?: (message: AgentChatMessage) => void | Promise<void>;
  onFeedback?: (
    message: AgentChatMessage,
    value: AgentFeedbackValue,
  ) => void | Promise<void>;
  onCopy?: (message: AgentChatMessage) => void | Promise<void>;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentMessage({
  message,
  actions,
  onRetry,
  onFeedback,
  onCopy,
  className,
  style,
  theme,
  copy,
}: AgentMessageProps) {
  const context = useAgentContext();
  const colors = withThemeOverrides(context.theme, theme);
  const labels = { ...context.copy, ...copy };
  const isUser = message.role === "user";
  const [feedback, setFeedback] = useState<AgentFeedbackValue | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fallback =
    message.status === "failed"
      ? labels.failed
      : message.status === "cancelled"
        ? labels.cancelled
        : labels.thinking;

  const canRetry = !!onRetry && (
    actions?.retry === "always" ||
    (actions?.retry === "failed" && message.status === "failed")
  );
  const canFeedback = !!onFeedback && actions?.feedback === "binary" && message.status === "completed";
  const canCopy = actions?.copy === true && message.content.length > 0;
  const showUsage = actions?.usage === "tokens" && message.usage;
  const hasActions = !isUser && (canRetry || canFeedback || canCopy || !!showUsage);

  const submitFeedback = async (value: AgentFeedbackValue) => {
    if (!onFeedback || actionPending) return;
    const previous = feedback;
    setFeedback(value);
    setActionPending(true);
    setActionError(null);
    try {
      await onFeedback(message, value);
    } catch (error) {
      setFeedback(previous);
      setActionError(error instanceof Error ? error.message : "Feedback could not be saved");
    } finally {
      setActionPending(false);
    }
  };

  const retry = async () => {
    if (!onRetry || actionPending) return;
    setActionPending(true);
    setActionError(null);
    try {
      await onRetry(message);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Retry could not be started");
    } finally {
      setActionPending(false);
    }
  };

  const copyMessage = async () => {
    try {
      if (onCopy) await onCopy(message);
      else await globalThis.navigator?.clipboard?.writeText(message.content);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Message could not be copied");
    }
  };

  return (
    <article
      className={className}
      aria-label={isUser ? labels.userLabel : labels.assistantLabel}
      style={{
        alignSelf: isUser ? "flex-end" : "stretch",
        maxWidth: isUser ? "min(82%, 620px)" : "100%",
        color: message.status === "failed" ? colors.statusBad : colors.ink,
        background: isUser ? colors.well : "transparent",
        borderRadius: isUser ? colors.containerRadius : 0,
        padding: isUser ? "8px 12px" : 0,
        fontSize: 13,
        lineHeight: 1.52,
        whiteSpace: isUser ? "pre-wrap" : "normal",
        overflowWrap: "anywhere",
        ...style,
      }}
    >
      {message.content ? (
        isUser ? message.content : (
          <AgentMarkdown streaming={message.status === "streaming"} {...(theme === undefined ? {} : { theme })}>{message.content}</AgentMarkdown>
        )
      ) : fallback}
      {hasActions ? (
        <footer style={{ display: "flex", minHeight: 24, alignItems: "center", gap: 8, marginTop: 7, color: colors.inkTertiary, fontSize: 11 }}>
          {canCopy ? <button type="button" onClick={() => void copyMessage()} style={messageActionStyle(colors)}>Copy</button> : null}
          {canRetry ? <button type="button" disabled={actionPending} onClick={() => void retry()} style={messageActionStyle(colors)}>Retry</button> : null}
          {canFeedback ? <>
            <button type="button" aria-pressed={feedback === "positive"} aria-label="Helpful response" disabled={actionPending} onClick={() => void submitFeedback("positive")} style={messageActionStyle(colors)}>Helpful</button>
            <button type="button" aria-pressed={feedback === "negative"} aria-label="Unhelpful response" disabled={actionPending} onClick={() => void submitFeedback("negative")} style={messageActionStyle(colors)}>Not helpful</button>
          </> : null}
          {showUsage ? <span style={{ marginLeft: "auto" }}>{message.usage?.totalTokens.toLocaleString()} tokens</span> : null}
        </footer>
      ) : null}
      {actionError ? <div role="alert" style={{ marginTop: 4, color: colors.statusBad, fontSize: 11 }}>{actionError}</div> : null}
    </article>
  );
}

function messageActionStyle(colors: AgentTheme): CSSProperties {
  return {
    border: 0,
    padding: "2px 0",
    color: colors.inkTertiary,
    background: "transparent",
    cursor: "pointer",
    font: "inherit",
  };
}

export interface AgentToolCallProps extends StyledProps {
  toolCall: AgentToolCall;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

function formatToolPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function humanizeToolName(name: string): string {
  const action = name.split(/[./:]/u).at(-1) ?? name;
  const words = action.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Use tool";
}

function deriveToolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entry = Object.entries(input as Record<string, unknown>).find(
    ([, value]) => typeof value === "string" || typeof value === "number",
  );
  if (!entry) return undefined;
  const value = String(entry[1]);
  return value.length > 42 ? `${value.slice(0, 39)}…` : value;
}

function ToolActionGlyph({ name, color }: { name: string; color: string }) {
  const normalized = name.toLowerCase();
  if (normalized.includes("search") || normalized.includes("lookup") || normalized.includes("find")) {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="5" cy="5" r="3.25" stroke={color} strokeWidth="1.2" />
        <path d="m7.5 7.5 2.3 2.3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (normalized.includes("read") || normalized.includes("file") || normalized.includes("document")) {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 1.5h4l2 2V10.5H3z" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M7 1.8V4h2.1" stroke={color} strokeWidth="1.1" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.2 2.2 2.1 6l2.1 3.8M7.8 2.2 9.9 6 7.8 9.8" stroke={color} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusGlyph({ status, colors }: { status: AgentToolCallStatus; colors: AgentTheme }) {
  if (status === "completed") {
    return <span aria-hidden="true" style={{ color: colors.statusGood, fontSize: 12 }}>✓</span>;
  }
  if (status === "failed") {
    return <span aria-hidden="true" style={{ color: colors.statusBad, fontSize: 13 }}>×</span>;
  }
  if (status === "approval_required") {
    return <span aria-hidden="true" style={{ color: colors.statusWarn, fontSize: 11 }}>?</span>;
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        border: `1.5px solid ${colors.hairline}`,
        borderTopColor: colors.inkSecondary,
        borderRadius: "50%",
      }}
    />
  );
}

export function AgentToolCall({ toolCall, className, style, theme, copy }: AgentToolCallProps) {
  const context = useAgentContext();
  const colors = withThemeOverrides(context.theme, theme);
  const labels = { ...context.copy, ...copy };
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hasDetails = toolCall.input !== undefined || toolCall.output !== undefined || toolCall.error !== undefined;
  const title = toolCall.label === toolCall.name ? humanizeToolName(toolCall.name) : toolCall.label;
  const summary = toolCall.summary ?? deriveToolSummary(toolCall.input);
  const statusLabel =
    toolCall.status === "completed"
      ? labels.toolCompleted
      : toolCall.status === "failed"
        ? labels.toolFailed
        : toolCall.status === "approval_required"
          ? labels.toolApprovalRequired
          : labels.toolRunning;

  return (
    <div className={className} style={{ color: colors.inkSecondary, ...style }}>
      <button
        type="button"
        aria-expanded={hasDetails ? expanded : undefined}
        aria-label={`${title}: ${statusLabel}`}
        disabled={!hasDetails}
        onClick={() => hasDetails && setExpanded((current) => !current)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          display: "flex",
          width: "100%",
          minHeight: 28,
          alignItems: "center",
          gap: 7,
          padding: "0 4px",
          border: 0,
          borderRadius: 6,
          color: "inherit",
          background: hovered ? colors.well : "transparent",
          cursor: hasDetails ? "pointer" : "default",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ display: "grid", width: 12, placeItems: "center", flex: "0 0 12px" }}>
          {hovered && hasDetails ? (
            <span style={{ fontSize: 14, lineHeight: 1, transform: expanded ? "rotate(90deg)" : undefined }}>›</span>
          ) : (
            <ToolActionGlyph name={toolCall.name} color={colors.inkSecondary} />
          )}
        </span>
        <span style={{ fontSize: 11, fontWeight: 550, lineHeight: 1.2 }}>{title}</span>
        {summary ? (
          <span
            style={{
              minWidth: 0,
              maxWidth: "55%",
              overflow: "hidden",
              padding: "3px 6px",
              borderRadius: 5,
              background: colors.well,
              color: colors.inkSecondary,
              fontSize: 11,
              lineHeight: 1,
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ display: "grid", width: 16, minHeight: 24, placeItems: "center" }}>
          <StatusGlyph status={toolCall.status} colors={colors} />
        </span>
      </button>
      {expanded && hasDetails ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            margin: "3px 0 7px 9px",
            padding: "3px 0 3px 14px",
            borderLeft: `1px solid ${colors.hairline}`,
            color: colors.inkSecondary,
            fontFamily: colors.monoFamily,
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {toolCall.input !== undefined ? (
            <div>
              <div style={{ marginBottom: 2, color: colors.inkTertiary, fontFamily: colors.fontFamily }}>Input</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>
                {formatToolPayload(toolCall.input)}
              </pre>
            </div>
          ) : null}
          {toolCall.output !== undefined ? (
            <div>
              <div style={{ marginBottom: 2, color: colors.inkTertiary, fontFamily: colors.fontFamily }}>Output</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>
                {formatToolPayload(toolCall.output)}
              </pre>
            </div>
          ) : null}
          {toolCall.error !== undefined ? (
            <div>
              <div style={{ marginBottom: 2, color: colors.statusBad, fontFamily: colors.fontFamily }}>Error</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>
                {formatToolPayload(toolCall.error)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface AgentMessageListProps extends StyledProps {
  messages: readonly AgentChatMessage[];
  toolCalls?: readonly AgentToolCall[];
  isWorking?: boolean;
  renderMessage?: (message: AgentChatMessage) => ReactNode;
  renderToolCall?: (toolCall: AgentToolCall) => ReactNode;
  messageActions?: AgentMessageActionConfig;
  onRetryMessage?: (message: AgentChatMessage) => void | Promise<void>;
  onFeedback?: (message: AgentChatMessage, value: AgentFeedbackValue) => void | Promise<void>;
  onCopyMessage?: (message: AgentChatMessage) => void | Promise<void>;
  workingStartedAt?: string | number | Date;
  thinkingVerbs?: readonly string[];
  renderThinking?: (state: AgentThinkingState) => ReactNode;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export interface AgentThinkingState {
  verb: string;
  elapsedMilliseconds: number;
  elapsedLabel: string;
}

export interface AgentThinkingIndicatorProps extends StyledProps {
  startedAt?: string | number | Date;
  verbs?: readonly string[];
  cycleMilliseconds?: number;
  showElapsed?: boolean;
  render?: (state: AgentThinkingState) => ReactNode;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

const agentThinkingKeyframes = `
@keyframes codespring-agent-sparkle-pulse {
  0%, 100% { opacity: .56; transform: scale(.92); }
  50% { opacity: .94; transform: scale(1); }
}
@keyframes codespring-agent-thinking-shimmer {
  from { background-position: 180% 0; }
  to { background-position: -80% 0; }
}
@media (prefers-reduced-motion: reduce) {
  [data-codespring-agent-thinking-sparkle] { animation: none !important; }
  [data-codespring-agent-thinking-label] {
    animation: none !important;
    background-image: none !important;
    -webkit-text-fill-color: currentColor !important;
  }
}`;

function parseStartedAt(value: string | number | Date | undefined, fallback: number): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function formatThinkingElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function AgentThinkingIndicator({
  startedAt,
  verbs,
  cycleMilliseconds = 4_200,
  showElapsed = true,
  render,
  className,
  style,
  theme,
  copy,
}: AgentThinkingIndicatorProps) {
  const context = useAgentContext();
  const colors = withThemeOverrides(context.theme, theme);
  const labels = { ...context.copy, ...copy };
  const fallbackStartedAt = useRef(Date.now());
  const startedAtMilliseconds = parseStartedAt(startedAt, fallbackStartedAt.current);
  const availableVerbs = verbs && verbs.length > 0
    ? verbs
    : labels.thinkingVerbs.length > 0
      ? labels.thinkingVerbs
      : [labels.thinking];
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 100);
    return () => globalThis.clearInterval(timer);
  }, []);

  const elapsedMilliseconds = Math.max(0, now - startedAtMilliseconds);
  const cycle = Math.max(800, cycleMilliseconds);
  const verb = availableVerbs[Math.floor(elapsedMilliseconds / cycle) % availableVerbs.length] ?? labels.thinking;
  const elapsedLabel = formatThinkingElapsed(elapsedMilliseconds);
  const thinkingState = { verb, elapsedMilliseconds, elapsedLabel };

  if (render) return <>{render(thinkingState)}</>;

  return (
    <div
      className={className}
      role="status"
      aria-label={showElapsed ? `${verb}, ${elapsedLabel} elapsed` : verb}
      style={{
        display: "flex",
        minHeight: 20,
        alignItems: "center",
        gap: 8,
        color: colors.inkSecondary,
        fontFamily: colors.fontFamily,
        fontSize: 11,
        ...style,
      }}
    >
      <style>{agentThinkingKeyframes}</style>
      <svg
        data-codespring-agent-thinking-sparkle=""
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{
          flex: "0 0 13px",
          color: colors.inkTertiary,
          transformOrigin: "center",
          animation: "codespring-agent-sparkle-pulse 1.4s ease-in-out infinite",
        }}
      >
        <path
          d="M8 1.8c.38 3.74 2.46 5.82 6.2 6.2-3.74.38-5.82 2.46-6.2 6.2C7.62 10.46 5.54 8.38 1.8 8 5.54 7.62 7.62 5.54 8 1.8Z"
          fill="currentColor"
        />
      </svg>
      <span
        data-codespring-agent-thinking-label=""
        aria-hidden="true"
        style={{
          color: colors.inkSecondary,
          backgroundImage: `linear-gradient(100deg, ${colors.inkTertiary} 18%, ${colors.ink} 46%, ${colors.inkTertiary} 74%)`,
          backgroundSize: "220% 100%",
          backgroundClip: "text",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          animation: "codespring-agent-thinking-shimmer 1.4s linear infinite",
        }}
      >
        {verb}…
      </span>
      {showElapsed ? <span aria-hidden="true" style={{ color: colors.inkTertiary, fontVariantNumeric: "tabular-nums" }}>{elapsedLabel}</span> : null}
    </div>
  );
}

export function AgentMessageList({
  messages,
  toolCalls = [],
  isWorking = false,
  renderMessage,
  renderToolCall,
  messageActions,
  onRetryMessage,
  onFeedback,
  onCopyMessage,
  workingStartedAt,
  thinkingVerbs,
  renderThinking,
  className,
  style,
  theme,
  copy,
}: AgentMessageListProps) {
  const context = useAgentContext();
  const colors = withThemeOverrides(context.theme, theme);
  const labels = { ...context.copy, ...copy };
  const end = useRef<HTMLDivElement>(null);
  const scrollSurface = useRef<HTMLDivElement>(null);
  const atLiveEdge = useRef(true);
  const transcript = [
    ...messages.map((message) => ({ type: "message" as const, item: message })),
    ...toolCalls.map((toolCall) => ({ type: "tool" as const, item: toolCall })),
  ].sort((left, right) => left.item.eventId - right.item.eventId);

  useEffect(() => {
    if (atLiveEdge.current) end.current?.scrollIntoView({ block: "end" });
  }, [messages, toolCalls, isWorking]);

  return (
    <div
      className={className}
      aria-live="polite"
      ref={scrollSurface}
      onScroll={() => {
        const element = scrollSurface.current;
        if (element) atLiveEdge.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      style={{
        display: "flex",
        width: "100%",
        maxWidth: colors.contentMaxWidth,
        flex: 1,
        flexDirection: "column",
        alignSelf: "center",
        gap: 16,
        overflowY: "auto",
        padding: "20px 24px 24px",
        ...style,
      }}
    >
      {transcript.length === 0 && !isWorking ? (
        <div style={{ margin: "auto", color: colors.inkSecondary, fontSize: 13 }}>{labels.empty}</div>
      ) : null}
      {transcript.map((row) => {
        if (row.type === "tool") {
          return renderToolCall ? (
            <div key={`tool:${row.item.id}`}>{renderToolCall(row.item)}</div>
          ) : (
            <AgentToolCall
              key={`tool:${row.item.id}`}
              toolCall={row.item}
              {...(theme === undefined ? {} : { theme })}
              {...(copy === undefined ? {} : { copy })}
            />
          );
        }
        return renderMessage ? (
          <div key={`message:${row.item.id}`}>{renderMessage(row.item)}</div>
        ) : (
          <AgentMessage
            key={`message:${row.item.id}`}
            message={row.item}
            {...(messageActions === undefined ? {} : { actions: messageActions })}
            {...(onRetryMessage === undefined ? {} : { onRetry: onRetryMessage })}
            {...(onFeedback === undefined ? {} : { onFeedback })}
            {...(onCopyMessage === undefined ? {} : { onCopy: onCopyMessage })}
            {...(theme === undefined ? {} : { theme })}
            {...(copy === undefined ? {} : { copy })}
          />
        );
      })}
      {isWorking && !messages.some((message) => message.status === "streaming") ? (
        <AgentThinkingIndicator
          {...(workingStartedAt === undefined ? {} : { startedAt: workingStartedAt })}
          {...(thinkingVerbs === undefined ? {} : { verbs: thinkingVerbs })}
          {...(renderThinking === undefined ? {} : { render: renderThinking })}
          {...(theme === undefined ? {} : { theme })}
          {...(copy === undefined ? {} : { copy })}
        />
      ) : null}
      <div ref={end} />
    </div>
  );
}

export interface AgentComposerAttachment {
  id: string;
  fileName: string;
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
  asset?: ExternalAssetRef;
  error?: string;
}

export interface AgentAttachmentController {
  attachments: readonly AgentComposerAttachment[];
  readyAssets: ExternalAssetRef[];
  pending: boolean;
  addFiles: (files: readonly File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export function useAgentAttachments(
  adapter?: AgentAttachmentAdapter,
): AgentAttachmentController {
  const [attachments, setAttachments] = useState<AgentComposerAttachment[]>([]);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const latest = useRef(attachments);
  useEffect(() => { latest.current = attachments; }, [attachments]);

  const upload = (id: string, file: File) => {
    if (!adapter) return;
    controllers.current.get(id)?.abort();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    setAttachments((current) => current.map((attachment) => {
      if (attachment.id !== id) return attachment;
      const { asset: _asset, error: _error, ...rest } = attachment;
      return { ...rest, status: "uploading" };
    }));
    void adapter.upload(file, { signal: controller.signal }).then((asset) => {
      if (controller.signal.aborted) return;
      setAttachments((current) => current.map((attachment) => {
        if (attachment.id !== id) return attachment;
        const { error: _error, ...rest } = attachment;
        return { ...rest, status: "ready", asset };
      }));
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      setAttachments((current) => current.map((attachment) => {
        if (attachment.id !== id) return attachment;
        const { asset: _asset, ...rest } = attachment;
        return {
          ...rest,
          status: "failed",
          error: error instanceof Error ? error.message : "Attachment upload failed",
        };
      }));
    }).finally(() => {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    });
  };

  const remove = (id: string) => {
    const attachment = latest.current.find((candidate) => candidate.id === id);
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    files.current.delete(id);
    if (attachment) {
      URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.asset) void adapter?.remove?.(attachment.asset);
    }
    setAttachments((current) => current.filter((candidate) => candidate.id !== id));
  };

  const clear = () => {
    for (const attachment of latest.current) {
      controllers.current.get(attachment.id)?.abort();
      URL.revokeObjectURL(attachment.previewUrl);
    }
    controllers.current.clear();
    files.current.clear();
    setAttachments([]);
  };

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    for (const attachment of latest.current) URL.revokeObjectURL(attachment.previewUrl);
  }, []);

  return {
    attachments,
    readyAssets: attachments.flatMap((attachment) => attachment.asset ? [attachment.asset] : []),
    pending: attachments.some((attachment) => attachment.status !== "ready"),
    addFiles: (selected) => {
      if (!adapter) return;
      const available = Math.max(0, (adapter.maximumFiles ?? 4) - latest.current.length);
      for (const file of selected.slice(0, available)) {
        const id = crypto.randomUUID();
        files.current.set(id, file);
        setAttachments((current) => [...current, {
          id,
          fileName: file.name,
          previewUrl: URL.createObjectURL(file),
          status: "uploading",
        }]);
        upload(id, file);
      }
    },
    retry: (id) => {
      const file = files.current.get(id);
      if (file) upload(id, file);
    },
    remove,
    clear,
  };
}

export interface AgentComposerProps extends StyledProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  disabled?: boolean;
  error?: string | null;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onCancel?: () => void | Promise<void>;
  maxRows?: number;
  attachments?: readonly AgentComposerAttachment[];
  attachmentAccept?: string;
  onAttachFiles?: (files: readonly File[]) => void;
  onRetryAttachment?: (id: string) => void;
  onRemoveAttachment?: (id: string) => void;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
}

export function AgentComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  error,
  leadingActions,
  trailingActions,
  onCancel,
  maxRows = 8,
  attachments = [],
  attachmentAccept,
  onAttachFiles,
  onRetryAttachment,
  onRemoveAttachment,
  className,
  style,
  theme,
  copy,
}: AgentComposerProps) {
  const context = useAgentContext();
  const colors = withThemeOverrides(context.theme, theme);
  const labels = { ...context.copy, ...copy };
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const lineHeight = Number.parseFloat(globalThis.getComputedStyle(element).lineHeight);
    const resolvedLineHeight = Number.isFinite(lineHeight) ? lineHeight : 19;
    const maximumHeight = resolvedLineHeight * Math.max(1, Math.floor(maxRows));
    element.style.height = "auto";
    const naturalHeight = element.scrollHeight;
    element.style.height = `${Math.min(naturalHeight, maximumHeight)}px`;
    element.style.overflowY = naturalHeight > maximumHeight + 1 ? "auto" : "hidden";
  }, [maxRows, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (value.trim() && !disabled) void onSubmit();
    }
  };
  const uploadPending = attachments.some((attachment) => attachment.status === "uploading");
  const uploadFailed = attachments.some((attachment) => attachment.status === "failed");
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !uploadPending && !uploadFailed;

  const acceptFiles = (files: readonly File[]) => {
    if (files.length > 0) onAttachFiles?.(files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    acceptFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onAttachFiles) return;
    event.preventDefault();
    setDragging(false);
    acceptFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className={className}
      style={{
        width: "100%",
        maxWidth: colors.contentMaxWidth,
        margin: "0 auto",
        padding: "16px 24px 10px",
        ...style,
      }}
    >
      <div
        onDragEnter={(event) => { if (onAttachFiles) { event.preventDefault(); setDragging(true); } }}
        onDragOver={(event) => { if (onAttachFiles) event.preventDefault(); }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={onDrop}
        style={{
          display: "grid",
          gap: 8,
          padding: "12px 10px 10px 14px",
          background: colors.well,
          border: `1px solid ${error ? colors.statusBad : dragging ? colors.accent : colors.hairline}`,
          borderRadius: 14,
        }}
      >
        {attachments.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {attachments.map((attachment) => (
              <div key={attachment.id} style={{ position: "relative", width: 72, height: 72, overflow: "hidden", borderRadius: 10, border: `1px solid ${attachment.status === "failed" ? colors.statusBad : colors.hairline}`, background: colors.canvas }}>
                <img src={attachment.previewUrl} alt={attachment.fileName} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: attachment.status === "ready" ? 1 : 0.52 }} />
                {attachment.status === "uploading" ? (
                  <span aria-label="Uploading attachment" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: colors.ink, fontSize: 10, background: "rgba(0,0,0,.18)" }}>Uploading</span>
                ) : null}
                {attachment.status === "failed" ? (
                  <button type="button" onClick={() => onRetryAttachment?.(attachment.id)} style={{ position: "absolute", inset: 0, border: 0, color: colors.ink, background: "rgba(0,0,0,.55)", cursor: "pointer", font: "inherit", fontSize: 10 }}>Retry</button>
                ) : null}
                <button type="button" aria-label={`Remove ${attachment.fileName}`} onClick={() => onRemoveAttachment?.(attachment.id)} style={{ position: "absolute", top: 4, right: 4, display: "grid", width: 18, height: 18, placeItems: "center", padding: 0, border: 0, borderRadius: "50%", color: "white", background: "rgba(0,0,0,.72)", cursor: "pointer", fontSize: 12 }}>×</button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          aria-label={labels.placeholder}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? labels.sending : labels.placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{
            flex: 1,
            width: "100%",
            minHeight: 22,
            maxHeight: `${Math.max(1, Math.floor(maxRows)) * 1.45}em`,
            overflowY: "hidden",
            resize: "none",
            border: 0,
            outline: 0,
            padding: 0,
            color: colors.ink,
            background: "transparent",
            fontFamily: colors.fontFamily,
            fontSize: 13,
            lineHeight: 1.45,
          }}
        />
        <div style={{ display: "flex", minHeight: 28, alignItems: "center", gap: 7 }}>
          {onAttachFiles ? (
            <>
              <input ref={fileInput} type="file" multiple accept={attachmentAccept} tabIndex={-1} aria-hidden="true" style={{ display: "none" }} onChange={(event) => { acceptFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
              <button type="button" aria-label="Attach files" title="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()} style={{ display: "grid", width: 26, height: 26, placeItems: "center", padding: 0, border: 0, borderRadius: 7, color: colors.inkSecondary, background: "transparent", cursor: disabled ? "default" : "pointer" }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.2 8.6 9.7 4a2.5 2.5 0 0 1 3.6 3.5l-5.4 5.4a3.6 3.6 0 0 1-5.1-5.1l5.1-5.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </>
          ) : null}
          {leadingActions}
          <span style={{ flex: 1 }} />
          {trailingActions}
          <button
            type="button"
            aria-label={disabled && onCancel ? "Stop agent" : labels.send}
            title={disabled && onCancel ? "Stop agent" : labels.send}
            disabled={disabled ? !onCancel : !canSend}
            onClick={() => void (disabled && onCancel ? onCancel() : onSubmit())}
            style={{
              display: "grid",
              width: 26,
              height: 26,
              placeItems: "center",
              padding: 0,
              border: 0,
              borderRadius: "50%",
              color: colors.canvas,
              background: disabled && !onCancel ? colors.inkTertiary : colors.ink,
              cursor: disabled && !onCancel ? "default" : !disabled && !canSend ? "default" : "pointer",
              opacity: !disabled && !canSend ? 0.38 : 1,
            }}
          >
            {disabled && onCancel ? (
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 1, background: colors.canvas }} />
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 9.5v-7M3.2 5.2 6 2.4l2.8 2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {error ? <div style={{ color: colors.statusBad, fontSize: 11, padding: "7px 4px 0" }}>{error}</div> : null}
    </div>
  );
}

export interface AgentChatProps extends StyledProps {
  sessionId: string;
  header?: ReactNode;
  composerLeadingActions?: ReactNode;
  composerTrailingActions?: ReactNode;
  composerMaxRows?: number;
  attachmentAdapter?: AgentAttachmentAdapter;
  thinkingVerbs?: readonly string[];
  renderThinking?: (state: AgentThinkingState) => ReactNode;
  /** @deprecated Prefer the header slot; the default chat has no header. */
  title?: string;
  theme?: Partial<AgentTheme>;
  copy?: Partial<AgentCopy>;
  renderMessage?: (message: AgentChatMessage) => ReactNode;
  renderToolCall?: (toolCall: AgentToolCall) => ReactNode;
  messageActions?: AgentMessageActionConfig;
  onRetryMessage?: (message: AgentChatMessage) => void | Promise<void>;
  onFeedback?: (message: AgentChatMessage, value: AgentFeedbackValue) => void | Promise<void>;
  onCopyMessage?: (message: AgentChatMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export function AgentChat({
  sessionId,
  header,
  composerLeadingActions,
  composerTrailingActions,
  composerMaxRows,
  attachmentAdapter,
  thinkingVerbs,
  renderThinking,
  title,
  className,
  style,
  theme,
  copy,
  renderMessage,
  renderToolCall,
  messageActions,
  onRetryMessage,
  onFeedback,
  onCopyMessage,
  onError,
}: AgentChatProps) {
  const context = useAgentContext();
  const colors = withThemeOverrides(context.theme, theme);
  const labels = { ...context.copy, ...copy };
  const session = useAgentSession(sessionId);
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const attachmentController = useAgentAttachments(attachmentAdapter);
  const isWorking =
    session.snapshot?.turns.some((turn) => turn.status === "queued" || turn.status === "running") ??
    false;
  const activeTurn = session.snapshot?.turns.find(
    (turn) => turn.status === "queued" || turn.status === "running",
  );

  const submit = async () => {
    const content = draft.trim();
    const assets = attachmentController.readyAssets;
    if ((!content && assets.length === 0) || isWorking || attachmentController.pending) return;
    setDraft("");
    setSubmitError(null);
    try {
      await session.submit(content, { attachments: assets });
      attachmentController.clear();
    } catch (error) {
      setDraft(content);
      const normalized = error instanceof Error ? error : new Error(String(error));
      setSubmitError(normalized.message);
      onError?.(normalized);
    }
  };

  return (
    <section
      className={className}
      style={{
        display: "flex",
        width: "100%",
        minHeight: 480,
        height: "100%",
        flexDirection: "column",
        overflow: "hidden",
        color: colors.ink,
        background: colors.canvas,
        fontFamily: colors.fontFamily,
        fontSize: 13,
        ...style,
      }}
    >
      {header ?? title ? (
        <header
          style={{
            width: "100%",
            maxWidth: colors.contentMaxWidth,
            margin: "0 auto",
            padding: "16px 24px 8px",
            color: colors.ink,
            fontSize: 15,
            fontWeight: 650,
          }}
        >
          {header ?? title}
        </header>
      ) : null}
      <div
        style={{
          display: "flex",
          width: "100%",
          minHeight: 0,
          flex: 1,
          flexDirection: "column",
        }}
      >
        {session.status === "loading" && session.messages.length === 0 ? (
          <div style={{ margin: "auto", color: colors.inkSecondary, fontSize: 13 }}>{labels.loading}</div>
        ) : (
          <AgentMessageList
            messages={session.messages}
            toolCalls={session.toolCalls}
            isWorking={isWorking}
            {...(activeTurn?.createdAt === undefined ? {} : { workingStartedAt: activeTurn.createdAt })}
            {...(thinkingVerbs === undefined ? {} : { thinkingVerbs })}
            {...(renderThinking === undefined ? {} : { renderThinking })}
            {...(renderMessage === undefined ? {} : { renderMessage })}
            {...(renderToolCall === undefined ? {} : { renderToolCall })}
            {...(messageActions === undefined ? {} : { messageActions })}
            {...(onRetryMessage === undefined ? {} : { onRetryMessage })}
            {...(onFeedback === undefined ? {} : { onFeedback })}
            {...(onCopyMessage === undefined ? {} : { onCopyMessage })}
            {...(theme === undefined ? {} : { theme })}
            {...(copy === undefined ? {} : { copy })}
          />
        )}
        <div
          style={{
            flex: "0 0 auto",
            background: `linear-gradient(to bottom, transparent 0, ${colors.canvas} 18%)`,
          }}
        >
          <AgentComposer
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            disabled={isWorking}
            error={submitError ?? session.error?.message ?? null}
            leadingActions={composerLeadingActions}
            trailingActions={composerTrailingActions}
            attachments={attachmentController.attachments}
            {...(attachmentAdapter?.accept === undefined ? {} : { attachmentAccept: attachmentAdapter.accept })}
            {...(attachmentAdapter ? {
              onAttachFiles: attachmentController.addFiles,
              onRetryAttachment: attachmentController.retry,
              onRemoveAttachment: attachmentController.remove,
            } : {})}
            {...(composerMaxRows === undefined ? {} : { maxRows: composerMaxRows })}
            {...(activeTurn ? { onCancel: () => session.cancel(activeTurn.id) } : {})}
            {...(theme === undefined ? {} : { theme })}
            {...(copy === undefined ? {} : { copy })}
          />
        </div>
      </div>
    </section>
  );
}

export { createBrowserClient } from "./client";
export type { BrowserAgentClientOptions, SessionSnapshot } from "./types";

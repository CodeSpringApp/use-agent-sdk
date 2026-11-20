import type { SessionWorkspace as PlaygroundWorkspace, WorkspaceFile } from "./types";
import { AgentChat, AgentMarkdown, AgentToolCall, useAgentSession, useAgentClient, useAgentTheme, type AgentChatProps } from "./react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workspaceCss } from "./workspace-styles";
import type { ButtonHTMLAttributes, CSSProperties } from "react";

const paths = { file: "M9.25 2.25h-5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-7ZM9.25 2.25v3.5h3.5M5.75 8.5h4.5M5.75 11h3", check: "m3.25 8.75 3.25 3.25 6.25-7.75", refresh: "M13.25 6A5.5 5.5 0 1 0 13 10.25M13.25 2.75V6H10", copy: "M5.25 5.25h8v8h-8ZM10.75 3V2.75H2.75v8H3", download: "M8 2.25v7.5M5.25 7 8 9.75 10.75 7M2.75 10.75v2.5h10.5v-2.5", chat: "M3 2.75h10v8.5H7L3 14Z" };
function Icon({ name, size = 16, className }: { name: keyof typeof paths; size?: number; className?: string }) { return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}><path d={paths[name]}/></svg>; }
function Button({ size: _size, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string }) { return <button {...props} type="button" className={`uaw-button ${className}`}/>; }
function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement>) { return <Button {...props} className="uaw-icon-button"/>; }
const cn = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(" ");
function useWorkspaceTheme(): CSSProperties {
  const theme = useAgentTheme();
  return { "--shq-canvas": theme.canvas, "--shq-fg": theme.ink, "--shq-fg-muted": theme.inkSecondary, "--shq-fg-dim": theme.inkTertiary, "--shq-line": theme.hairline, "--shq-line-hi": theme.hairline, "--shq-success": theme.statusGood, "--shq-danger": theme.statusBad, "--shq-warning": theme.statusWarn, "--shq-font-sans": theme.fontFamily, "--shq-font-mono": theme.monoFamily, color: theme.ink, background: theme.canvas, fontFamily: theme.fontFamily } as CSSProperties;
}

export type WorkbenchStatus = "Ready" | "Working" | "Stopped" | "Failed" | "Connecting" | "Reconnecting";
/** Read files only after durable changes, on reconnect, or on explicit refresh. */
export function useAgentWorkspace(sessionId: string) {
  const client = useAgentClient();
  const session = useAgentSession(sessionId);
  const revision = `${session.events.filter(event => ["tool.completed", "turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)).at(-1)?.id ?? 0}:${session.connection}`;
  // Changing client or session hides old contents during render, before effects run.
  const scope = useMemo(() => ({ client, sessionId }), [client, sessionId]);
  const [data, setData] = useState<{ scope: typeof scope; value: PlaygroundWorkspace } | null>(null);
  const [selection, setSelection] = useState<{ scope: typeof scope; path: string | null } | null>(null);
  const [failure, setFailure] = useState<{ scope: typeof scope; message: string } | null>(null);
  const [pending, setPending] = useState<{ scope: typeof scope; loading: boolean } | null>(null);
  const workspace = data?.scope === scope ? data.value : null;
  const selected = selection?.scope === scope ? selection.path : null;
  const error = failure?.scope === scope ? failure.message : null;
  const loading = pending?.scope === scope ? pending.loading : true;
  const select = useCallback((path: string | null) => setSelection({ scope, path }), [scope]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(key => key + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setPending({ scope, loading: true }); setFailure(null);
    const api = client.sessions.get(sessionId).workspace;
    void Promise.all([api.list({ signal: controller.signal }), selected === null ? Promise.resolve(null) : api.read(selected, { signal: controller.signal })])
      .then(([snapshot, file]) => ({ ...snapshot, file }))
      .then(result => {
        if (controller.signal.aborted) return;
        setData({ scope, value: result });
        if (selected === null && result.files[0]) select(result.files[0].path);
      })
      .catch(reason => { if (!controller.signal.aborted) setFailure({ scope, message: reason instanceof Error ? reason.message : "Files could not be loaded" }); })
      .finally(() => { if (!controller.signal.aborted) setPending({ scope, loading: false }); });
    return () => controller.abort();
  }, [client, sessionId, selected, revision, refreshKey, scope, select]);
  return { files: workspace?.files ?? [], file: workspace?.file?.path === selected ? workspace.file : null, executionHarness: workspace?.executionHarness ?? null, selected, select, error, loading, refresh };
}

export function AgentWorkspace({ sessionId, title = "Workspace", actions, onInspect, className, style }: { sessionId: string; title?: ReactNode; actions?: ReactNode; onInspect?: () => void; className?: string; style?: CSSProperties }) {
  const session = useAgentSession(sessionId);
  const latest = session.snapshot?.turns.at(-1);
  const working = session.snapshot?.turns.some(turn => turn.status === "queued" || turn.status === "running") ?? false;
  const status: WorkbenchStatus = session.error ? "Failed"
    : session.connection === "reconnecting" ? "Reconnecting"
    : session.status === "loading" || session.connection === "connecting" ? "Connecting"
    : working ? "Working" : latest?.status === "cancelled" ? "Stopped" : latest?.status === "failed" ? "Failed" : "Ready";
  const files = useAgentWorkspace(sessionId);
  const [tab, setTab] = useState<"conversation" | "files">("conversation");
  const selectFile = (path: string) => { files.select(path); setTab("files"); };
  const renderToolCall: NonNullable<AgentChatProps["renderToolCall"]> = call => {
    if (!call.name.startsWith("codespring_workspace_")) return <AgentToolCall toolCall={call}/>;
    const input = call.input as { path?: unknown } | undefined;
    const path = typeof input?.path === "string" ? input.path : null;
    const verb = call.name.endsWith("write") ? "Saved" : call.name.endsWith("read") ? "Read" : "Listed files";
    const done = call.status === "completed";
    return <button type="button" disabled={!done || !path} onClick={() => { if (path) selectFile(path); }} className="workspace-tool" title={path ?? undefined}>
      <Icon name="file"/><span>{call.status === "failed" ? "File action failed" : done ? verb : "Working"}</span>{path ? <span className="uaw-truncate uaw-font-mono uaw-text-fg-muted">{path}</span> : null}{done ? <Icon name="check" size={12}/> : null}
    </button>;
  };
  return <AgentWorkspaceLayout {...(className ? { className } : {})} {...(style ? { style } : {})} title={session.snapshot?.inference?.source === "chatgpt_plan" ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}>{title}<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" title="Manage ChatGPT usage" style={{ fontSize: 12, opacity: 0.65, whiteSpace: "nowrap" }}>ChatGPT plan ↗</a></div> : title} status={status} actions={actions} tab={tab} onTabChange={setTab}
    fileCount={files.files.length}
    conversation={<>
      {session.error ? <div role="alert" className="workspace-error"><span>{session.error.message}</span><Button size="sm" onClick={() => void session.refresh().catch(() => undefined)}>Reconnect</Button></div> : null}
      {!session.error && !working && latest?.status === "failed" ? <div role="alert" className="workspace-error"><span>This turn could not finish.</span>{onInspect ? <Button onClick={onInspect}>View details</Button> : null}</div> : null}
      <AgentChat key={sessionId} sessionId={sessionId} style={{ minHeight: 0, background: "transparent", flex: 1 }} className="uaw-min-h-0 uaw-flex-1"
        copy={{ empty: "What would you like to work on?", placeholder: "Describe a task…" }} renderThinking={() => null} renderToolCall={renderToolCall}
        messageActions={{ copy: true, usage: false, retry: false, feedback: false }}/>
    </>}
    files={<AgentWorkspaceFiles {...files} onSelect={files.select}/>}/>;
}

export function AgentWorkspaceLayout({ title, status, actions, conversation, files, tab, onTabChange, fileCount, className, style }: {
  className?: string; style?: CSSProperties;
  title: ReactNode; status: WorkbenchStatus; actions?: ReactNode; conversation: ReactNode; files: ReactNode;
  tab: "conversation" | "files"; onTabChange: (tab: "conversation" | "files") => void; fileCount: number;
}) {
  const theme = useWorkspaceTheme();
  return <div className={cn("uaw-root workspace-workbench", className)} style={{ ...theme, ...style }}><style>{workspaceCss}</style>
    <header className="workspace-header">
      <div className="uaw-min-w-0">{title}</div>
      <div className="uaw-flex uaw-shrink-0 uaw-items-center uaw-gap-3">
        <span role="status" className="workspace-status" data-status={status}><span aria-hidden="true"/>{status}</span>{actions}
      </div>
    </header>
    <div className="workspace-mobile-tabs" aria-label="Workspace view">
      <button type="button" aria-pressed={tab === "conversation"} onClick={() => onTabChange("conversation")}><Icon name="chat"/>Conversation</button>
      <button type="button" aria-pressed={tab === "files"} onClick={() => onTabChange("files")}><Icon name="file"/>Files<span className="workspace-count">{fileCount}</span></button>
    </div>
    <div className="workspace-panes" data-tab={tab}>
      <section aria-label="Conversation" className="workspace-conversation">{conversation}</section>
      <section aria-label="Workspace files" className="workspace-files">{files}</section>
    </div>
  </div>;
}

type FileContent = WorkspaceFile & { content: string };
export function AgentWorkspaceFiles({ files, file, selected, onSelect, error, loading, refresh }: {
  files: WorkspaceFile[]; file: FileContent | null; selected: string | null; onSelect: (path: string) => void;
  error: string | null; loading: boolean; refresh: () => void;
}) {
  const theme = useWorkspaceTheme();
  const [view, setView] = useState<"preview" | "source">("preview");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { setCopyState("idle"); return () => clearTimeout(copyTimer.current); }, [file?.path, file?.version]);
  const markdown = file?.path.toLowerCase().match(/\.(md|markdown)$/) !== null && !!file;
  async function copy() {
    if (!file) return;
    try { await navigator.clipboard.writeText(file.content); setCopyState("copied"); } catch { setCopyState("failed"); }
    clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopyState("idle"), 2500);
  }
  function download() {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = file.path.split("/").at(-1) ?? "file.txt";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="uaw-root" style={{ ...theme, display: "contents" }}><style>{workspaceCss}</style>
    <div className="workspace-files-heading"><div className="uaw-flex uaw-items-center uaw-gap-2"><Icon name="file"/><h2>Files</h2><span className="workspace-count">{files.length}</span></div><IconButton aria-label="Refresh files" title="Refresh files" disabled={loading} onClick={refresh}><Icon name="refresh" className={loading ? "uaw-animate-spin" : ""}/></IconButton></div>
    {error ? <div role="alert" className="workspace-error"><span>{error}</span><Button size="sm" onClick={refresh}>Retry</Button></div> : null}
    {files.length > 0 ? <>
      <nav className="workspace-file-list" aria-label="Files">{files.map(item => <button key={item.path} type="button" aria-current={selected === item.path ? "true" : undefined} onClick={() => onSelect(item.path)} title={item.path}>
        <Icon name="file"/><span className="uaw-truncate">{item.path}</span><span className="uaw-ml-auto uaw-shrink-0 uaw-font-mono uaw-text-2xs uaw-text-fg-dim">{formatBytes(item.sizeBytes)}</span>
      </button>)}</nav>
      {file ? <>
        <div className="workspace-file-toolbar">
          <div className="uaw-flex uaw-min-w-0 uaw-items-center uaw-gap-2"><span className="uaw-truncate uaw-text-xs uaw-text-fg-muted" title={file.path}>{file.path.split("/").at(-1)}</span><span className="uaw-font-mono uaw-text-2xs uaw-text-fg-dim">v{file.version}</span></div>
          <div className="uaw-flex uaw-shrink-0 uaw-items-center uaw-gap-1">
            {markdown ? <button type="button" className="workspace-source-toggle" aria-pressed={view === "source"} onClick={() => setView(value => value === "preview" ? "source" : "preview")}>{view === "preview" ? "Source" : "Preview"}</button> : null}
            <IconButton aria-label={copyState === "copied" ? "Copied" : "Copy file"} title="Copy file" onClick={() => void copy()}>{copyState === "copied" ? <Icon name="check"/> : <Icon name="copy"/>}</IconButton>
            <IconButton aria-label="Download file" title="Download file" onClick={download}><Icon name="download"/></IconButton>
          </div>
        </div>
        <div role="status" className="uaw-sr-only">{copyState === "copied" ? "File copied" : ""}</div>
        {copyState === "failed" ? <p role="alert" className="uaw-px-4 uaw-py-2 uaw-text-xs uaw-text-danger">Copy failed. Download the file instead.</p> : null}
        <div className={cn("workspace-file-content", loading && "uaw-opacity-60")} aria-busy={loading}>
          {markdown && view === "preview" ? <div className="workspace-markdown"><AgentMarkdown components={{ img: ({ alt }) => <span className="uaw-text-fg-dim">[Image{alt ? `: ${alt}` : ""}]</span> }}>{file.content}</AgentMarkdown></div>
            : <pre className="workspace-source" tabIndex={0} aria-label={`${file.path} source`}><code>{file.content || " "}</code></pre>}
        </div>
        <footer className="workspace-file-footer"><span>{markdown ? "Markdown" : file.path.split(".").at(-1)?.toUpperCase() || "Text"}</span><span>{file.content.split("\n").length} lines<span className="uaw-px-2">·</span>{formatBytes(file.sizeBytes)}</span></footer>
      </> : <div className="workspace-files-empty" role="status">{loading ? "Opening file…" : "Choose a file"}</div>}
    </> : <div className="workspace-files-empty" role="status">
      {loading ? <div className="uaw-w-full uaw-space-y-3 uaw-px-8"><div className="uaw-h-2 uaw-w-3-4 uaw-animate-pulse uaw-rounded uaw-bg-white-6"/><div className="uaw-h-2 uaw-w-1-2 uaw-animate-pulse uaw-rounded uaw-bg-white-6"/></div>
        : <><span className="workspace-empty-glyph"><Icon name="file" size={24}/></span><p className="uaw-mt-4 uaw-text-sm uaw-text-fg-muted">No files yet</p><p className="uaw-mt-1 uaw-text-xs uaw-text-fg-dim">Files saved by your agent appear here.</p></>}
    </div>}
  </div>;
}

function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }

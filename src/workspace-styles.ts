export const workspaceCss = `
.uaw-root { box-sizing: border-box; font-size:13px; line-height:1.6; }
.uaw-root *, .uaw-root *::before, .uaw-root *::after { box-sizing: border-box; }
.uaw-root button { font-family:inherit; cursor:pointer; background:transparent; border:0; color:inherit; line-height:inherit; }
.uaw-root button:disabled { cursor:default; }
.uaw-root h2, .uaw-root p { margin:0; }
.uaw-root h2 { font-size:inherit; font-weight:500; }
.uaw-root button:focus-visible, .uaw-root pre:focus-visible { outline:2px solid var(--shq-fg-muted); outline-offset:2px; }
.uaw-root .uaw-button { padding:4px 9px; border:1px solid var(--shq-line); border-radius:6px; font-size:12px; color:var(--shq-fg-muted); }
.uaw-root .uaw-icon-button { display:inline-grid; place-items:center; width:28px; height:28px; padding:0; border:0; }
.uaw-root .uaw-icon-button:hover { background:var(--shq-line); }
.uaw-root .uaw-icon-button:disabled { opacity:.5; }
@keyframes uaw-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .uaw-root *, .uaw-root *::before, .uaw-root *::after { animation:none !important; transition:none !important; } }
.uaw-root .uaw-flex{display:flex}
.uaw-root .uaw-items-center{align-items:center}
.uaw-root .uaw-gap-1{gap:4px}
.uaw-root .uaw-gap-2{gap:8px}
.uaw-root .uaw-gap-3{gap:12px}
.uaw-root .uaw-min-w-0{min-width:0}
.uaw-root .uaw-min-h-0{min-height:0}
.uaw-root .uaw-shrink-0{flex-shrink:0}
.uaw-root .uaw-flex-1{flex:1}
.uaw-root .uaw-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uaw-root .uaw-font-mono{font-family:var(--shq-font-mono)}
.uaw-root .uaw-text-fg-muted{color:var(--shq-fg-muted)}
.uaw-root .uaw-text-fg-dim{color:var(--shq-fg-dim)}
.uaw-root .uaw-text-danger{color:var(--shq-danger)}
.uaw-root .uaw-text-xs{font-size:12px}
.uaw-root .uaw-text-sm{font-size:13px}
.uaw-root .uaw-text-2xs{font-size:10px}
.uaw-root .uaw-ml-auto{margin-left:auto}
.uaw-root .uaw-mt-4{margin-top:16px}
.uaw-root .uaw-mt-1{margin-top:4px}
.uaw-root .uaw-px-2{padding-left:8px;padding-right:8px}
.uaw-root .uaw-px-4{padding-left:16px;padding-right:16px}
.uaw-root .uaw-px-8{padding-left:32px;padding-right:32px}
.uaw-root .uaw-py-2{padding-top:8px;padding-bottom:8px}
.uaw-root .uaw-w-full{width:100%}
.uaw-root .uaw-space-y-3{display:flex;flex-direction:column;gap:12px}
.uaw-root .uaw-h-2{height:8px}
.uaw-root .uaw-w-3-4{width:75%}
.uaw-root .uaw-w-1-2{width:50%}
.uaw-root .uaw-rounded{border-radius:4px}
.uaw-root .uaw-bg-white-6{background:var(--shq-line)}
.uaw-root .uaw-opacity-60{opacity:.6}
.uaw-root .uaw-animate-spin{animation:uaw-spin 1s linear infinite}
.uaw-root .uaw-animate-pulse{animation:workspace-pulse 1.8s ease-in-out infinite}
.uaw-root .uaw-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* The workbench uses the dashboard palette and keeps activity in one place. */
.uaw-root.workspace-workbench { container-type: inline-size; container-name: uaw-workbench; display: flex; flex: 1; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
.uaw-root .workspace-header { display: flex; min-height: 64px; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; border-bottom: 1px solid var(--shq-line); }
.uaw-root .workspace-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--shq-fg-muted); }
.uaw-root .workspace-status > span { width: 5px; height: 5px; border-radius: 50%; background: var(--shq-fg-dim); }
.uaw-root .workspace-status[data-status="Ready"] > span { background: var(--shq-success); }
.uaw-root .workspace-status[data-status="Working"] > span { background: var(--shq-success); animation: workspace-pulse 1.8s ease-in-out infinite; }
.uaw-root .workspace-status[data-status="Failed"] > span { background: var(--shq-danger); }
.uaw-root .workspace-status[data-status="Reconnecting"] > span { background: var(--shq-warning); }
.uaw-root .workspace-panes { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); flex: 1; min-height: 0; }
.uaw-root .workspace-conversation,.uaw-root .workspace-files { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.uaw-root .workspace-files { border-left: 1px solid var(--shq-line); background: rgb(255 255 255 / .012); }
.uaw-root .workspace-files-heading { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; color: var(--shq-fg-muted); font-size: 12px; border-bottom: 1px solid var(--shq-line); }
.uaw-root .workspace-count { display: inline-flex; justify-content: center; align-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 4px; font: 10px var(--shq-font-mono); color: var(--shq-fg-dim); background: rgb(255 255 255 / .04); }
.uaw-root .workspace-file-list { flex-shrink: 0; max-height: 164px; overflow-y: auto; padding: 8px; border-bottom: 1px solid var(--shq-line); }
.uaw-root .workspace-file-list button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 5px; font-size: 12px; text-align: left; color: var(--shq-fg-muted); }
.uaw-root .workspace-file-list button:hover { background: rgb(255 255 255 / .025); color: var(--shq-fg); }
.uaw-root .workspace-file-list button[aria-current] { background: rgb(255 255 255 / .055); color: var(--shq-fg); }
.uaw-root .workspace-file-list svg { flex-shrink: 0; opacity: .65; }
.uaw-root .workspace-file-toolbar { display: flex; flex-shrink: 0; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--shq-line); }
.uaw-root .workspace-source-toggle { border-radius: 4px; padding: 4px 7px; font-size: 11px; color: var(--shq-fg-muted); }
.uaw-root .workspace-source-toggle:hover { color: var(--shq-fg); background: rgb(255 255 255 / .04); }
.uaw-root .workspace-file-content { flex: 1; min-height: 0; overflow: auto; transition: opacity 120ms; }
.uaw-root .workspace-markdown { padding: 24px; overflow-wrap: anywhere; }
.uaw-root .workspace-markdown ul { list-style: disc; padding-left: 20px; }
.uaw-root .workspace-markdown ol { list-style: decimal; padding-left: 20px; }
.uaw-root .workspace-markdown li { padding-left: 3px; margin: 6px 0; }
.uaw-root .workspace-source { min-height: 100%; margin: 0; padding: 22px; font: 12px/1.9 var(--shq-font-mono); tab-size: 2; color: var(--shq-fg-muted); }
.uaw-root .workspace-file-footer { display: flex; flex-shrink: 0; justify-content: space-between; border-top: 1px solid var(--shq-line); padding: 8px 16px; color: var(--shq-fg-dim); font-size: 10px; }
.uaw-root .workspace-files-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; min-height: 140px; padding: 24px; text-align: center; color: var(--shq-fg-dim); }
.uaw-root .workspace-empty-glyph { display: grid; place-items: center; width: 48px; height: 56px; border: 1px solid var(--shq-line-hi); border-radius: 9px; box-shadow: 5px 5px 0 -1px var(--shq-canvas), 5px 5px 0 0 var(--shq-line); }
.uaw-root .workspace-tool { display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 6px 0; font-size: 11px; color: var(--shq-fg-dim); text-align: left; }
.uaw-root .workspace-tool:not(:disabled):hover { color: var(--shq-fg); }
.uaw-root .workspace-tool svg { flex-shrink: 0; }
.uaw-root .workspace-error { display: flex; flex-shrink: 0; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--shq-line); color: var(--shq-danger); font-size: 12px; }
.uaw-root .workspace-mobile-tabs { display: none; }
@container uaw-workbench (max-width: 680px) {
  .uaw-root .workspace-header { padding: 12px 16px; }
  .uaw-root .workspace-mobile-tabs { display: flex; padding: 0 16px; gap: 20px; border-bottom: 1px solid var(--shq-line); flex-shrink: 0; }
  .uaw-root .workspace-mobile-tabs button { display: flex; align-items: center; gap: 7px; padding: 12px 0; font-size: 12px; color: var(--shq-fg-dim); border-bottom: 1px solid transparent; }
  .uaw-root .workspace-mobile-tabs button[aria-pressed="true"] { color: var(--shq-fg); border-color: var(--shq-fg-muted); }
  .uaw-root .workspace-panes { display: flex; flex-direction: column; }
  .uaw-root .workspace-panes > section { flex: 1; }
  .uaw-root .workspace-panes[data-tab="conversation"] > .workspace-files, .uaw-root .workspace-panes[data-tab="files"] > .workspace-conversation { display: none; }
  .uaw-root .workspace-files { border-left: 0; }
}
@keyframes workspace-pulse { 50% { opacity: .3; } }


`;

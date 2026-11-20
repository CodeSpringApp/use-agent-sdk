import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createAgent, createClient } from "../src";
import { AgentProvider, AgentWorkspaceFiles } from "../src/react";
import { runCli } from "../src/cli";

test("workspace transport preserves explicit ownership, paths, signals, and server failures", async () => {
  const requests: Request[] = [];
  const file = { path: "notes/a & b.md", content: "# Hello", version: 2, sizeBytes: 7 };
  const client = createClient({ endpoint: "https://runtime.test", apiKey: "test-key", fetch: async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (request.method === "POST") return Response.json({ sessionId: "session-1" });
    if (request.url.endsWith("/capabilities")) return Response.json({ schemaVersion: 1, workspace: { enabled: false, canCreate: false } });
    if (new URL(request.url).searchParams.get("path") === "missing") return Response.json({ error: { code: "workspace_file_not_found", message: "Missing" } }, { status: 404 });
    return Response.json({ executionHarness: "codex_wasm_v1", files: [file], file });
  } });
  const session = await client.sessions.create(createAgent({ id: "writer", revision: "1" }), { executionHarness: "codex_wasm_v1", browserUserId: "authenticated-user" });
  expect(await requests[0]!.json()).toEqual({ agentRevisionId: "writer@1", executionHarness: "codex_wasm_v1", browserUserId: "authenticated-user" });
  expect((await session.workspace.list()).files[0]?.path).toBe(file.path);
  expect(await session.workspace.read(file.path)).toEqual(file);
  expect(new URL(requests[2]!.url).searchParams.get("path")).toBe(file.path);
  expect((await client.capabilities.get()).workspace.enabled).toBe(false);
  await expect(session.workspace.read("missing")).rejects.toMatchObject({ code: "workspace_file_not_found", status: 404 });
  const controller = new AbortController(); controller.abort();
  await session.workspace.list({ signal: controller.signal });
  expect(requests.at(-1)!.signal.aborted).toBe(true);
});

test("workspace rendering keeps HTML inert and prevents remote image loads", () => {
  const file = { path: "result.md", version: 1, sizeBytes: 99, content: '# Notes\n\n**Ready**\n\n![remote](https://tracker.test/private)\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>' };
  const render = (path: string) => renderToStaticMarkup(<AgentProvider client={createClient({ endpoint: "https://fixture.test", apiKey: "test" })}><AgentWorkspaceFiles files={[{ ...file, path }]} file={{ ...file, path }} selected={path} onSelect={() => {}} loading={false} error={null} refresh={() => {}}/></AgentProvider>);
  expect(render("result.md")).toMatch(/<strong[^>]*>Ready<\/strong>/);
  for (const path of ["result.md", "result.html"]) {
    const html = render(path); expect(html).not.toContain("<img"); expect(html).not.toContain("<script>"); expect(html).not.toContain('href="javascript:');
  }
  expect(render("result.html")).toContain("&lt;script&gt;");
});

test("CLI requires explicit session mutations and inspects files without writes", async () => {
  let output = ""; const requests: Request[] = [];
  const deps = { env: { CODESPRING_AGENTS_API_KEY: "test-key" }, stdout: { write: (text: string) => { output += text; } }, stderr: { write: () => {} }, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init)); return Response.json({ sessionId: "test-session", executionHarness: "codex_wasm_v1", files: [], file: { path: "notes.md", version: 1, content: "hello", sizeBytes: 5 } });
  }) as typeof fetch };
  expect(await runCli(["sessions", "create", "--agent", "writer@1", "--harness", "codex_wasm_v1"], deps)).toBe(2); expect(requests).toHaveLength(0);
  expect(await runCli(["sessions", "create", "--agent", "writer@1", "--harness", "invalid", "--yes"], deps)).toBe(2); expect(requests).toHaveLength(0);
  expect(await runCli(["sessions", "create", "--agent", "writer@1", "--harness", "codex_wasm_v1", "--yes", "--json"], deps)).toBe(0);
  expect(await requests[0]!.json()).toEqual({ agentRevisionId: "writer@1", executionHarness: "codex_wasm_v1" });
  expect(await runCli(["workspace", "read", "test-session", "--path", "notes.md", "--json"], deps)).toBe(0);
  expect(requests[1]!.method).toBe("GET"); expect(output).toContain('"content":"hello"'); expect(output).not.toContain("test-key");
  expect(await runCli(["sessions", "submit", "test-session", "--message", "Hello", "--yes"], deps)).toBe(2); expect(requests).toHaveLength(2);
  expect(await runCli(["workspace", "list", "test-session", "--api-key", "secret"], deps)).toBe(2); expect(requests).toHaveLength(2);
});

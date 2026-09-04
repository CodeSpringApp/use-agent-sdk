import { describe, expect, test } from "bun:test";
import {
  createMcpAppsHost,
  createMcpAppSandboxUrl,
  createSessionMcpAppsHost,
  getMcpAppDescriptor,
} from "../src/mcp-apps";
import type { AgentSession } from "../src/client";

describe("MCP Apps host", () => {
  test("accepts a dedicated secure sandbox and freezes the policy", () => {
    const host = createMcpAppsHost({
      sandboxUrl: "https://mcp-apps.example.com/sandbox",
      maxHeight: 50_000,
      loadResource: async () => ({ html: "<!doctype html><title>App</title>" }),
    });

    expect(host.sandboxUrl).toBe("https://mcp-apps.example.com/sandbox");
    expect(host.maxHeight).toBe(2_000);
    expect(Object.isFrozen(host)).toBe(true);
  });

  test("rejects insecure remote sandbox URLs", () => {
    expect(() => createMcpAppsHost({
      sandboxUrl: "http://mcp-apps.example.com/",
      loadResource: async () => ({ html: "" }),
    })).toThrow("must use HTTPS");
  });

  test("extracts only bounded ui resource descriptors", () => {
    expect(getMcpAppDescriptor({
      _meta: {
        ui: {
          resourceUri: "ui://weather/dashboard",
          serverId: "weather",
          snapshotId: "weather@3",
        },
      },
    })).toEqual({
      resourceUri: "ui://weather/dashboard",
      serverId: "weather",
      snapshotId: "weather@3",
    });
    expect(getMcpAppDescriptor({ _meta: { ui: { resourceUri: "https://example.com/app" } } })).toBeNull();
    expect(getMcpAppDescriptor({ content: [] })).toBeNull();
  });

  test("binds sandbox policy to the embedding origin before navigation", () => {
    const url = new URL(createMcpAppSandboxUrl(
      "https://sandbox.example/sandbox.html",
      "https://host.example",
      {
        csp: { connectDomains: ["https://api.example"] },
        permissions: { clipboardWrite: {} },
      },
    ));
    expect(url.searchParams.get("hostOrigin")).toBe("https://host.example");
    expect(JSON.parse(url.searchParams.get("csp") ?? "{}")).toEqual({
      connectDomains: ["https://api.example"],
    });
    expect(JSON.parse(url.searchParams.get("permissions") ?? "{}")).toEqual({
      clipboardWrite: {},
    });
  });

  test("binds resource reads and app tool calls to the pinned session descriptor", async () => {
    const reads: unknown[] = [];
    const calls: unknown[] = [];
    const session = {
      readMcpAppResource: async (input: unknown) => {
        reads.push(input);
        return {
          serverId: "weather",
          snapshotId: "weather@3",
          resourceUri: "ui://weather/dashboard",
          resourceDigest: "a".repeat(64),
          mediaType: "text/html;profile=mcp-app",
          html: "<main>Weather</main>",
          csp: null,
          permissions: null,
        };
      },
      callMcpAppTool: async (input: unknown) => {
        calls.push(input);
        return { content: [{ type: "text", text: "Sunny" }] };
      },
    } as unknown as AgentSession;
    const host = createSessionMcpAppsHost({
      session,
      sandboxUrl: "https://mcp-apps.example.com/sandbox",
    });
    const context = {
      descriptor: {
        resourceUri: "ui://weather/dashboard" as const,
        serverId: "weather",
        snapshotId: "weather@3",
      },
      toolName: "weather.current",
    };
    await expect(host.loadResource(context, new AbortController().signal))
      .resolves.toEqual({ html: "<main>Weather</main>" });
    await expect(host.callTool?.(context, {
      name: "weather.refresh",
      arguments: { city: "Delhi" },
    }, new AbortController().signal)).resolves.toMatchObject({
      content: [{ type: "text", text: "Sunny" }],
    });
    expect(reads).toEqual([{
      serverId: "weather",
      snapshotId: "weather@3",
      resourceUri: "ui://weather/dashboard",
    }]);
    expect(calls).toEqual([{
      serverId: "weather",
      snapshotId: "weather@3",
      resourceUri: "ui://weather/dashboard",
      toolName: "weather.refresh",
      arguments: { city: "Delhi" },
    }]);
  });
});

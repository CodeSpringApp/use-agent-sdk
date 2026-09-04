import { describe, expect, test } from "bun:test";
import {
  createMcpAppsHost,
  getMcpAppDescriptor,
} from "../src/mcp-apps";

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
});

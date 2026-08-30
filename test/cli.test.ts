import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import type { CredentialStore } from "../src/cli-auth";

class Sink {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

class MemoryCredentialStore implements CredentialStore {
  value: string | null = null;
  async get() { return this.value; }
  async set(value: string) {
    this.value = value;
    return true;
  }
  async delete() { this.value = null; }
}

describe("Use Agent CLI", () => {
  test("prints digest-verified packaged skill content offline", async () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(["skills", "get", "app-builder"], { stdout, stderr, env: {} });

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("# Build a CodeSpring Agents application");
    expect(stderr.value).toBe("");
  });

  test("does not accept credentials as command arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "use-agent-cli-no-argument-secret-"));
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(["agents", "list", "--api-key", "secret"], {
      stdout,
      stderr,
      env: {},
      homeDirectory: root,
      credentialStore: new MemoryCredentialStore(),
    });

    expect(exitCode).toBe(3);
    expect(stderr.value).toContain("CODESPRING_AGENTS_API_KEY");
    expect(stderr.value).not.toContain("secret");
  });

  test("installs only the discovery stub at an explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "use-agent-cli-"));
    const destination = join(root, "use-agent");
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(
      ["skills", "install", "--path", destination, "--yes"],
      { stdout, stderr, env: {} },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toContain(
      "use-agent skills get app-builder",
    );
    expect(stdout.value).toContain("Installed");
  });

  test("completes device login without exposing OAuth credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "use-agent-device-login-"));
    const stdout = new Sink();
    const stderr = new Sink();
    const credentialStore = new MemoryCredentialStore();
    let tokenPolls = 0;
    const requests: string[] = [];
    const fetchMock = (async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({
          issuer: "https://server.codespring.app/api/auth",
          device_authorization_endpoint: "https://server.codespring.app/api/auth/device/code",
          token_endpoint: "https://server.codespring.app/api/auth/oauth2/token",
        });
      }
      if (url.endsWith("/device/code")) {
        return json({
          device_code: "device-secret",
          user_code: "ABCDEFGH",
          verification_uri: "https://app.codespring.app/device",
          verification_uri_complete: "https://app.codespring.app/device?user_code=ABCDEFGH",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/oauth2/token")) {
        tokenPolls += 1;
        if (tokenPolls === 1) {
          return json(
            { error: "authorization_pending", error_description: "Pending" },
            400,
          );
        }
        return json({
          access_token: "oauth-access-secret",
          refresh_token: "oauth-refresh-secret",
          expires_in: 600,
          token_type: "Bearer",
        });
      }
      if (url.endsWith("/auth/v1/cli/access")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer oauth-access-secret",
        );
        return json({
          productAccess: { state: "active" },
          workspaces: [{
            tenantId: "tenant-1",
            slug: "acme",
            displayName: "Acme",
            role: "owner",
            environments: [{
              environmentId: "environment-1",
              slug: "production",
              kind: "production",
            }],
          }],
        });
      }
      if (url.endsWith("/auth/v1/cli/token-exchange")) {
        return json({
          token: "uacli_runtime-secret",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          tenantId: "tenant-1",
          environmentId: "environment-1",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const exitCode = await runCli(["auth", "login", "--no-browser"], {
      stdout,
      stderr,
      env: {},
      homeDirectory: root,
      credentialStore,
      fetch: fetchMock,
      sleep: async () => {},
    });

    expect(exitCode).toBe(0);
    expect(credentialStore.value).toBe("oauth-refresh-secret");
    expect(stderr.value).toContain("ABCD-EFGH");
    expect(`${stdout.value}${stderr.value}`).not.toContain("device-secret");
    expect(`${stdout.value}${stderr.value}`).not.toContain("oauth-access-secret");
    expect(`${stdout.value}${stderr.value}`).not.toContain("oauth-refresh-secret");
    expect(`${stdout.value}${stderr.value}`).not.toContain("uacli_runtime-secret");
    expect(requests.some((request) => request.endsWith("/auth/v1/cli/token-exchange"))).toBe(true);

    const config = JSON.parse(
      await readFile(join(root, ".config", "codespring", "use-agent.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config.tenantId).toBe("tenant-1");
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  test("uses a saved refresh token for later management commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "use-agent-device-refresh-"));
    const configPath = join(root, ".config", "codespring", "use-agent.json");
    await mkdir(join(root, ".config", "codespring"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        authIssuer: "https://server.codespring.app/api/auth",
        runtimeEndpoint: "https://api.agents.codespring.app",
        tenantId: "tenant-1",
        environmentId: "environment-1",
        workspaceName: "Acme",
        environmentName: "production",
        createdAt: new Date().toISOString(),
      }),
    );
    const credentialStore = new MemoryCredentialStore();
    credentialStore.value = "old-refresh-token";
    const fetchMock = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({
          issuer: "https://server.codespring.app/api/auth",
          device_authorization_endpoint: "https://server.codespring.app/api/auth/device/code",
          token_endpoint: "https://server.codespring.app/api/auth/oauth2/token",
        });
      }
      if (url.endsWith("/oauth2/token")) {
        expect(String(init?.body)).toContain("refresh_token=old-refresh-token");
        return json({
          access_token: "refreshed-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 600,
          token_type: "Bearer",
        });
      }
      if (url.endsWith("/auth/v1/cli/token-exchange")) {
        return json({
          token: "uacli_fresh-token",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          tenantId: "tenant-1",
          environmentId: "environment-1",
        });
      }
      if (url.endsWith("/v1/agents?limit=50")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer uacli_fresh-token",
        );
        return json({ items: [], cursor: null, hasMore: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const stdout = new Sink();
    const stderr = new Sink();
    const exitCode = await runCli(["agents", "list"], {
      stdout,
      stderr,
      env: {},
      homeDirectory: root,
      credentialStore,
      fetch: fetchMock,
    });

    expect(exitCode).toBe(0);
    expect(stdout.value).toBe("No resources found.\n");
    expect(credentialStore.value).toBe("rotated-refresh-token");
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

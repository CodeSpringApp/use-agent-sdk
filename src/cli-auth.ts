import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_AUTH_ISSUER = "https://server.codespring.app/api/auth";
const DEFAULT_RUNTIME_ENDPOINT = "https://api.agents.codespring.app";
const CLI_CLIENT_ID = "use-agent-cli";
const AGENTS_RESOURCE = "https://api.agents.codespring.app";
const REQUESTED_SCOPE = "openid profile email offline_access agents";
const KEYCHAIN_SERVICE = "com.codespring.use-agent.cli";
const KEYCHAIN_ACCOUNT = "default";

type Writable = { write(chunk: string): unknown };

export type CredentialStore = {
  get(): Promise<string | null>;
  set(value: string): Promise<boolean>;
  delete(): Promise<void>;
};

export type CliAuthDependencies = {
  env: Record<string, string | undefined>;
  stderr: Writable;
  homeDirectory?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<boolean>;
  credentialStore?: CredentialStore;
};

export type DeviceLoginOptions = {
  noBrowser: boolean;
  tenant?: string;
  environment?: string;
};

export type StoredCliAuth = {
  schemaVersion: 1;
  authIssuer: string;
  runtimeEndpoint: string;
  tenantId: string;
  environmentId: string;
  workspaceName: string;
  environmentName: string;
  createdAt: string;
};

type OAuthMetadata = {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

type Workspace = {
  tenantId: string;
  slug: string;
  displayName: string;
  environments: Array<{
    environmentId: string;
    slug: string;
    kind: string;
  }>;
};

type AccessResponse = {
  workspaces: Workspace[];
  productAccess: { state: string };
};

type ExchangeResponse = {
  token: string;
  expiresAt: string;
  tenantId: string;
  environmentId: string;
};

export async function loginWithDevice(
  options: DeviceLoginOptions,
  dependencies: CliAuthDependencies,
): Promise<{ auth: StoredCliAuth; persistent: boolean }> {
  const request = fetchFor(dependencies);
  const authIssuer = dependencies.env.CODESPRING_AUTH_ISSUER ?? DEFAULT_AUTH_ISSUER;
  const runtimeEndpoint = dependencies.env.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_RUNTIME_ENDPOINT;
  const metadata = await discover(authIssuer, request);
  const device = await postForm(request, metadata.device_authorization_endpoint, {
    client_id: CLI_CLIENT_ID,
    scope: REQUESTED_SCOPE,
    resource: AGENTS_RESOURCE,
  });
  const parsedDevice = parseDeviceResponse(device);

  dependencies.stderr.write(
    `Open ${parsedDevice.verification_uri}\nEnter code: ${formatUserCode(parsedDevice.user_code)}\n`,
  );
  if (!options.noBrowser) {
    const opened = await (dependencies.openBrowser ?? openBrowser)(
      parsedDevice.verification_uri_complete,
    );
    if (!opened) dependencies.stderr.write("Could not open a browser automatically. Use the URL above.\n");
  }

  const token = await pollForToken(metadata.token_endpoint, parsedDevice, request, dependencies);
  if (!token.refresh_token) {
    throw new CliAuthError("refresh_token_missing", "CodeSpring did not return a refresh token");
  }
  const access = await getAccess(runtimeEndpoint, token.access_token, request);
  if (!["active", "cancel_scheduled", "quota_exhausted"].includes(access.productAccess.state)) {
    throw new CliAuthError(
      "agents_access_unavailable",
      `CodeSpring Agents access is ${access.productAccess.state.replaceAll("_", " ")}`,
    );
  }
  const selection = selectEnvironment(access.workspaces, options);
  await exchange(runtimeEndpoint, token.access_token, selection.tenantId, selection.environmentId, request);

  const auth: StoredCliAuth = {
    schemaVersion: 1,
    authIssuer,
    runtimeEndpoint,
    tenantId: selection.tenantId,
    environmentId: selection.environmentId,
    workspaceName: selection.workspaceName,
    environmentName: selection.environmentName,
    createdAt: new Date().toISOString(),
  };
  const store = dependencies.credentialStore ?? systemCredentialStore();
  const persistent = await store.set(token.refresh_token);
  if (!persistent) {
    throw new CliAuthError(
      "credential_store_unavailable",
      "Device login requires macOS Keychain or Linux Secret Service; no plaintext credential was saved",
    );
  }
  await writeAuthConfig(auth, dependencies.homeDirectory);
  return { auth, persistent: true };
}

export async function loadAuthenticatedCliToken(
  dependencies: CliAuthDependencies,
): Promise<{ token: string; auth: StoredCliAuth } | null> {
  const auth = await readAuthConfig(dependencies.homeDirectory);
  if (!auth) return null;
  const store = dependencies.credentialStore ?? systemCredentialStore();
  const refreshToken = await store.get();
  if (!refreshToken) return null;
  const request = fetchFor(dependencies);
  const metadata = await discover(auth.authIssuer, request);
  const refreshed = parseTokenResponse(
    await postForm(request, metadata.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLI_CLIENT_ID,
      resource: AGENTS_RESOURCE,
    }),
  );
  if (refreshed.refresh_token && refreshed.refresh_token !== refreshToken) {
    await store.set(refreshed.refresh_token);
  }
  const exchanged = await exchange(
    auth.runtimeEndpoint,
    refreshed.access_token,
    auth.tenantId,
    auth.environmentId,
    request,
  );
  return { token: exchanged.token, auth };
}

export async function readStoredCliAuth(
  dependencies: Pick<CliAuthDependencies, "homeDirectory" | "credentialStore">,
): Promise<StoredCliAuth | null> {
  const auth = await readAuthConfig(dependencies.homeDirectory);
  if (!auth) return null;
  const refreshToken = await (dependencies.credentialStore ?? systemCredentialStore()).get();
  return refreshToken ? auth : null;
}

export async function logoutDevice(
  dependencies: Pick<CliAuthDependencies, "homeDirectory" | "credentialStore">,
): Promise<boolean> {
  const existing = await readAuthConfig(dependencies.homeDirectory);
  await (dependencies.credentialStore ?? systemCredentialStore()).delete();
  try {
    await unlink(authConfigPath(dependencies.homeDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return existing !== null;
}

async function discover(issuer: string, request: typeof fetch): Promise<OAuthMetadata> {
  const parsedIssuer = secureUrl(issuer, "auth issuer");
  const candidates = [
    new URL("/.well-known/openid-configuration", parsedIssuer).toString(),
    `${parsedIssuer.toString().replace(/\/$/u, "")}/.well-known/openid-configuration`,
  ];
  let lastError: unknown;
  for (const url of [...new Set(candidates)]) {
    try {
      const response = await request(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`discovery returned ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (body.issuer !== parsedIssuer.toString().replace(/\/$/u, "")) {
        throw new Error("discovery issuer does not match the configured issuer");
      }
      return {
        issuer: String(body.issuer),
        device_authorization_endpoint: secureUrl(
          String(body.device_authorization_endpoint ?? ""),
          "device authorization endpoint",
        ).toString(),
        token_endpoint: secureUrl(String(body.token_endpoint ?? ""), "token endpoint").toString(),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new CliAuthError(
    "oauth_discovery_failed",
    lastError instanceof Error ? lastError.message : "CodeSpring OAuth discovery failed",
  );
}

async function postForm(
  request: typeof fetch,
  url: string,
  values: Record<string, string>,
): Promise<unknown> {
  const response = await request(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new OAuthResponseError(
      String(body.error ?? "oauth_request_failed"),
      String(body.error_description ?? `OAuth request failed with ${response.status}`),
    );
  }
  return body;
}

function parseDeviceResponse(value: unknown) {
  const body = record(value);
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string" ||
    typeof body.verification_uri_complete !== "string" ||
    !Number.isFinite(expiresIn) ||
    !Number.isFinite(interval)
  ) {
    throw new CliAuthError("invalid_device_response", "CodeSpring returned an invalid device response");
  }
  secureUrl(body.verification_uri, "verification URL");
  secureUrl(body.verification_uri_complete, "verification URL");
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    verification_uri_complete: body.verification_uri_complete,
    expires_in: Math.max(1, expiresIn),
    interval: Math.max(1, interval),
  };
}

async function pollForToken(
  tokenEndpoint: string,
  device: ReturnType<typeof parseDeviceResponse>,
  request: typeof fetch,
  dependencies: CliAuthDependencies,
): Promise<OAuthTokenResponse> {
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + device.expires_in * 1_000;
  let interval = device.interval * 1_000;
  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      return parseTokenResponse(await postForm(request, tokenEndpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: CLI_CLIENT_ID,
        resource: AGENTS_RESOURCE,
      }));
    } catch (error) {
      if (error instanceof OAuthResponseError && error.code === "authorization_pending") continue;
      if (error instanceof OAuthResponseError && error.code === "slow_down") {
        interval += 5_000;
        continue;
      }
      throw error;
    }
  }
  throw new CliAuthError("expired_token", "The device code expired before it was approved");
}

function parseTokenResponse(value: unknown): OAuthTokenResponse {
  const body = record(value);
  if (
    typeof body.access_token !== "string" ||
    typeof body.token_type !== "string" ||
    !Number.isFinite(Number(body.expires_in))
  ) {
    throw new CliAuthError("invalid_token_response", "CodeSpring returned an invalid token response");
  }
  return {
    access_token: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
    expires_in: Number(body.expires_in),
    token_type: body.token_type,
  };
}

async function getAccess(
  runtimeEndpoint: string,
  accessToken: string,
  request: typeof fetch,
): Promise<AccessResponse> {
  return runtimeJson(request, runtimeEndpoint, "/auth/v1/cli/access", accessToken, "GET") as Promise<AccessResponse>;
}

async function exchange(
  runtimeEndpoint: string,
  accessToken: string,
  tenantId: string,
  environmentId: string,
  request: typeof fetch,
): Promise<ExchangeResponse> {
  return runtimeJson(
    request,
    runtimeEndpoint,
    "/auth/v1/cli/token-exchange",
    accessToken,
    "POST",
    { tenantId, environmentId },
  ) as Promise<ExchangeResponse>;
}

async function runtimeJson(
  request: typeof fetch,
  endpoint: string,
  path: string,
  token: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const base = secureUrl(endpoint, "runtime endpoint");
  const response = await request(new URL(path, `${base.toString().replace(/\/$/u, "")}/`), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const nested = recordOrNull(value.error);
    throw new CliAuthError(
      String(nested?.code ?? value.code ?? (typeof value.error === "string" ? value.error : "runtime_auth_failed")),
      String(nested?.message ?? value.message ?? "The Agents runtime rejected CLI authentication"),
    );
  }
  return value;
}

function selectEnvironment(workspaces: Workspace[], options: DeviceLoginOptions) {
  const workspace = options.tenant
    ? workspaces.find((item) => item.tenantId === options.tenant || item.slug === options.tenant)
    : workspaces.length === 1
      ? workspaces[0]
      : undefined;
  if (!workspace) {
    throw new CliAuthError(
      "workspace_selection_required",
      `Choose a workspace with --tenant. Available: ${workspaces.map((item) => `${item.slug} (${item.tenantId})`).join(", ") || "none"}`,
    );
  }
  const environment = options.environment
    ? workspace.environments.find(
        (item) => item.environmentId === options.environment || item.slug === options.environment,
      )
    : workspace.environments.length === 1
      ? workspace.environments[0]
      : workspace.environments.filter((item) => item.kind === "production").length === 1
        ? workspace.environments.find((item) => item.kind === "production")
        : undefined;
  if (!environment) {
    throw new CliAuthError(
      "environment_selection_required",
      `Choose an environment with --environment. Available: ${workspace.environments.map((item) => `${item.slug} (${item.environmentId})`).join(", ") || "none"}`,
    );
  }
  return {
    tenantId: workspace.tenantId,
    environmentId: environment.environmentId,
    workspaceName: workspace.displayName,
    environmentName: environment.slug,
  };
}

async function readAuthConfig(homeDirectory?: string): Promise<StoredCliAuth | null> {
  try {
    const value = JSON.parse(await readFile(authConfigPath(homeDirectory), "utf8")) as StoredCliAuth;
    if (
      value.schemaVersion !== 1 ||
      !value.authIssuer ||
      !value.runtimeEndpoint ||
      !value.tenantId ||
      !value.environmentId
    ) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeAuthConfig(value: StoredCliAuth, homeDirectory?: string): Promise<void> {
  const path = authConfigPath(homeDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function authConfigPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".config", "codespring", "use-agent.json");
}

function systemCredentialStore(): CredentialStore {
  if (platform() === "darwin") {
    return {
      async get() {
        const result = await run("security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
        return result.code === 0 ? result.stdout.trim() || null : null;
      },
      async set(value) {
        const result = await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value]);
        return result.code === 0;
      },
      async delete() {
        await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
      },
    };
  }
  if (platform() === "linux") {
    return {
      async get() {
        const result = await run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
        return result.code === 0 ? result.stdout.trim() || null : null;
      },
      async set(value) {
        const result = await run(
          "secret-tool",
          ["store", "--label=CodeSpring Agents CLI", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
          value,
        );
        return result.code === 0;
      },
      async delete() {
        await run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
      },
    };
  }
  return {
    async get() { return null; },
    async set() { return false; },
    async delete() {},
  };
}

async function openBrowser(url: string): Promise<boolean> {
  secureUrl(url, "verification URL");
  const command = platform() === "darwin" ? "open" : platform() === "linux" ? "xdg-open" : null;
  if (!command) return false;
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ code: 1, stdout: "" });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout });
      }
    });
    child.stdin.end(input);
  });
}

function secureUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliAuthError("invalid_url", `${label} is invalid`);
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.username || parsed.password) {
    throw new CliAuthError("invalid_url", `${label} must use HTTPS without credentials`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliAuthError("invalid_response", "Authentication server returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatUserCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : value;
}

function fetchFor(dependencies: CliAuthDependencies): typeof fetch {
  return dependencies.fetch ?? globalThis.fetch.bind(globalThis);
}

class OAuthResponseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class CliAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

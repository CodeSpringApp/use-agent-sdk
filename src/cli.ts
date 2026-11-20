import { createAgent } from "./agent";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AgentError, createClient } from "./client";
import {
  CliAuthError,
  type CredentialStore,
  loadAuthenticatedCliToken,
  loginWithDevice,
  logoutDevice,
  readStoredCliAuth,
} from "./cli-auth";

type Writable = { write(chunk: string): unknown };

export interface CliDependencies {
  stdout?: Writable;
  stderr?: Writable;
  env?: Record<string, string | undefined>;
  homeDirectory?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<boolean>;
  credentialStore?: CredentialStore;
}

type SkillCatalog = {
  schemaVersion: 1;
  packageVersion: string;
  skills: Array<{
    name: string;
    description: string;
    path: string;
    sha256: string;
  }>;
};

const DEFAULT_ENDPOINT = "https://api.agents.codespring.app";

export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = dependencies.env ?? process.env;
  const [group, action, ...rest] = args;
  const json = args.includes("--json");

  try {
    if (!group || group === "help" || group === "--help" || group === "-h") {
      stdout.write(helpText);
      return 0;
    }

    if (group === "skills") {
      return runSkills(action, rest, {
        stdout,
        stderr,
        json,
        ...(dependencies.homeDirectory === undefined ? {} : { homeDirectory: dependencies.homeDirectory }),
      });
    }

    if (group === "auth" && action === "login") {
      if (environment.CODESPRING_AGENTS_API_KEY?.trim()) {
        throw new CliError(
          2,
          "api_key_environment_active",
          "Unset CODESPRING_AGENTS_API_KEY before interactive login",
        );
      }
      const tenant = option(rest, "--tenant");
      const environmentName = option(rest, "--environment");
      const result = await loginWithDevice(
        {
          noBrowser: rest.includes("--no-browser"),
          ...(tenant === undefined ? {} : { tenant }),
          ...(environmentName === undefined
            ? {}
            : { environment: environmentName }),
        },
        authDependencies(dependencies, environment, stderr),
      );
      const data = {
        authenticated: true,
        method: "device_oauth",
        endpoint: result.auth.runtimeEndpoint,
        workspace: result.auth.workspaceName,
        environment: result.auth.environmentName,
      };
      writeResult(
        stdout,
        json,
        data,
        `Authenticated with CodeSpring\nWorkspace: ${data.workspace}\nEnvironment: ${data.environment}\n`,
      );
      return 0;
    }

    if (group === "auth" && action === "logout") {
      const removed = await logoutDevice({
        ...(dependencies.homeDirectory === undefined
          ? {}
          : { homeDirectory: dependencies.homeDirectory }),
        ...(dependencies.credentialStore === undefined
          ? {}
          : { credentialStore: dependencies.credentialStore }),
      });
      writeResult(stdout, json, { authenticated: false, removed }, removed
        ? "Signed out of CodeSpring Agents.\n"
        : "No saved CodeSpring Agents login was found.\n");
      return 0;
    }

    if (group === "auth" && action === "status") {
      const apiKeyConfigured = Boolean(environment.CODESPRING_AGENTS_API_KEY?.trim());
      const stored = apiKeyConfigured
        ? null
        : await readStoredCliAuth({
            ...(dependencies.homeDirectory === undefined
              ? {}
              : { homeDirectory: dependencies.homeDirectory }),
            ...(dependencies.credentialStore === undefined
              ? {}
              : { credentialStore: dependencies.credentialStore }),
          });
      const data = {
        authenticated: apiKeyConfigured || stored !== null,
        method: apiKeyConfigured ? "api_key_environment" : stored ? "device_oauth" : null,
        endpoint: stored?.runtimeEndpoint ?? environment.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_ENDPOINT,
        ...(stored
          ? { workspace: stored.workspaceName, environment: stored.environmentName }
          : {}),
      };
      writeResult(stdout, json, data, apiKeyConfigured
        ? `Authenticated through CODESPRING_AGENTS_API_KEY\nEndpoint: ${data.endpoint}\n`
        : stored
          ? `Authenticated with CodeSpring\nWorkspace: ${stored.workspaceName}\nEnvironment: ${stored.environmentName}\n`
          : "Not authenticated. Run use-agent auth login, or set CODESPRING_AGENTS_API_KEY for CI.\n");
      return data.authenticated ? 0 : 3;
    }

    if (group === "doctor") {
      const catalog = await loadCatalog();
      const apiKeyConfigured = Boolean(environment.CODESPRING_AGENTS_API_KEY?.trim());
      const stored = apiKeyConfigured
        ? null
        : await readStoredCliAuth({
            ...(dependencies.homeDirectory === undefined
              ? {}
              : { homeDirectory: dependencies.homeDirectory }),
            ...(dependencies.credentialStore === undefined
              ? {}
              : { credentialStore: dependencies.credentialStore }),
          });
      const data = {
        node: process.version,
        endpoint: stored?.runtimeEndpoint ?? environment.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_ENDPOINT,
        authenticated: apiKeyConfigured || stored !== null,
        authMethod: apiKeyConfigured ? "api_key_environment" : stored ? "device_oauth" : null,
        skillCatalogVersion: catalog.packageVersion,
        skillCount: catalog.skills.length,
      };
      writeResult(stdout, json, data, `Runtime endpoint: ${data.endpoint}\nAuthentication: ${data.authMethod ?? "not configured"}\nSkills: ${data.skillCount} (${data.skillCatalogVersion})\n`);
      return data.authenticated ? 0 : 3;
    }

    if (group === "models" && (action === "discover" || action === "validate")) {
      const connection = option(rest, "--connection");
      if (!connection) throw new CliError(2, "connection_required", "Provide --connection with a stored provider connection ID");
      if (rest.some(arg => ["--api-key", "--secret", "--probe"].includes(arg))) {
        throw new CliError(2, "unsupported_option", "Model commands use stored provider keys and metadata checks only; secret arguments and inference probes are not supported");
      }
      const client = await authenticatedClient(environment, authDependencies(dependencies, environment, stderr));
      if (action === "discover") {
        const query = option(rest, "--query");
        const page = await client.providerModels.list(connection, { ...pageOptions(rest), ...(query ? { query } : {}), refresh: rest.includes("--refresh") });
        writeResult(stdout, json, page, `${page.stale ? "Cached" : "Updated"}: ${page.fetchedAt}\n${formatPage(page.items, "id", page.cursor)}${page.warning ? `${page.warning}\n` : ""}`);
      } else {
        const model = option(rest, "--model");
        if (!model) throw new CliError(2, "model_required", "Provide --model with an exact provider model ID");
        const result = await client.providerModels.validate(connection, model);
        writeResult(stdout, json, result, `${result.modelId}\nListed by provider: ${result.listed}\nAllowed by key policy: ${result.allowed}\nRuntime compatibility: ${result.compatibility}\nMetadata only; inference was not tested.\n`);
      }
      return 0;
    }

    if (group === "chatgpt" && ["status", "models", "connect", "disconnect"].includes(action ?? "")) {
      validateWorkspaceOptions(rest, ["--json", "--yes"]);
      if (["connect", "disconnect"].includes(action!) && !rest.includes("--yes")) throw new CliError(2, "confirmation_required", "Pass --yes to change the personal ChatGPT connection");
      if (environment.CODESPRING_AGENTS_API_KEY?.trim()) throw new CliError(2, "personal_login_required", "Unset CODESPRING_AGENTS_API_KEY and use a personal CLI login for ChatGPT plan access");
      const client = await authenticatedClient(environment, authDependencies(dependencies, environment, stderr));
      const result = action === "status" ? await client.chatGPTPlan.status() : action === "models" ? await client.chatGPTPlan.models() : action === "connect" ? await client.chatGPTPlan.authorize() : await client.chatGPTPlan.disconnect();
      writeResult(stdout, json, result, action === "connect" && "authorizationUrl" in result ? `Open this URL while signed into the same CodeSpring account and workspace:\n${result.authorizationUrl}\n` : `${JSON.stringify(result, null, 2)}\n`); return 0;
    }
    if (group === "capabilities" && (!action || action === "--json")) {
      validateWorkspaceOptions(args.slice(1), ["--json"]);
      const client = await authenticatedClient(environment, authDependencies(dependencies, environment, stderr));
      const result = await client.capabilities.get();
      writeResult(stdout, json, result, `Workspace: ${result.workspace.enabled ? "enabled" : "disabled"} (experimental)\nCan create: ${result.workspace.canCreate}\n`); return 0;
    }
    if (group === "sessions" && ["create", "get", "submit", "events", "cancel"].includes(action ?? "")) {
      const flags: Record<string, string[]> = { create: ["--agent", "--harness", "--chatgpt-model", "--chatgpt-grant", "--yes", "--json"], get: ["--json"], submit: ["--message", "--idempotency-key", "--yes", "--json"], events: ["--after", "--json"], cancel: ["--turn", "--yes", "--json"] };
      validateWorkspaceOptions(rest, flags[action!]!);
      const mutation = ["create", "submit", "cancel"].includes(action!);
      if (mutation && !rest.includes("--yes")) throw new CliError(2, "confirmation_required", "Pass --yes for this session mutation");
      const id = positional(rest)[0];
      if (action !== "create" && !id) throw new CliError(2, "session_id_required", "Provide a session ID");
      let agent: ReturnType<typeof createAgent> | undefined;
      const harness = option(rest, "--harness") ?? "native_v1";
      const planModel = option(rest, "--chatgpt-model"), planGrant = option(rest, "--chatgpt-grant");
      if (planModel || planGrant) {
        if (!planModel || !planGrant || harness !== "codex_wasm_v1") throw new CliError(2, "chatgpt_selection_required", "Provide --chatgpt-model, --chatgpt-grant and --harness codex_wasm_v1");
        if (environment.CODESPRING_AGENTS_API_KEY?.trim()) throw new CliError(2, "personal_login_required", "Use a personal CLI login for ChatGPT plan access");
      }
      if (action === "create") {
        const revision = option(rest, "--agent") ?? "";
        const separator = revision.lastIndexOf("@");
        if (separator < 1) throw new CliError(2, "agent_revision_required", "Use --agent ID@REVISION");
        if (harness !== "native_v1" && harness !== "codex_wasm_v1") throw new CliError(2, "invalid_harness", "Unknown execution harness");
        agent = createAgent({ id: revision.slice(0, separator), revision: revision.slice(separator + 1) });
      }
      const content = option(rest, "--message");
      const idempotencyKey = option(rest, "--idempotency-key");
      if (action === "submit" && (!content || !idempotencyKey)) throw new CliError(2, "turn_input_required", "Provide --message and --idempotency-key; reuse that key only when retrying the same submission");
      const turnId = option(rest, "--turn");
      if (action === "cancel" && !turnId) throw new CliError(2, "turn_id_required", "Provide --turn TURN_ID");
      const after = Number(option(rest, "--after") ?? "0");
      if (action === "events" && (!Number.isSafeInteger(after) || after < 0)) throw new CliError(2, "invalid_cursor", "--after must be a nonnegative integer");
      const client = await authenticatedClient(environment, authDependencies(dependencies, environment, stderr));
      let result: unknown;
      if (agent) {
        const created = await client.sessions.create(agent, { executionHarness: harness as "native_v1" | "codex_wasm_v1", ...(planModel && planGrant ? { inference: { source: "chatgpt_plan", model: planModel, grantId: planGrant } as const } : {}) });
        result = { sessionId: created.id, executionHarness: harness };
      } else {
        const session = client.sessions.get(id!);
        result = action === "get" ? await session.get() : action === "events" ? await session.events(after, 100)
          : action === "cancel" ? await session.cancel(turnId!) : await session.submit(content!, { idempotencyKey: idempotencyKey! });
      }
      writeResult(stdout, json, result, `${JSON.stringify(result, null, 2)}\n`); return 0;
    }
    if (group === "workspace" && (action === "list" || action === "read")) {
      validateWorkspaceOptions(rest, action === "read" ? ["--path", "--json"] : ["--json"]);
      const id = positional(rest)[0]; const path = option(rest, "--path");
      if (!id || (action === "read" && !path)) throw new CliError(2, "workspace_input_required", "Provide a session ID and --path for a file read");
      const client = await authenticatedClient(environment, authDependencies(dependencies, environment, stderr));
      const workspace = client.sessions.get(id).workspace;
      const result = action === "list" ? await workspace.list() : await workspace.read(path!);
      writeResult(stdout, json, result, `${JSON.stringify(result, null, 2)}\n`); return 0;
    }

    if ((group === "agents" || group === "tools") && (action === "list" || action === "get")) {
      const client = await authenticatedClient(
        environment,
        authDependencies(dependencies, environment, stderr),
      );
      if (group === "agents" && action === "list") {
        const page = await client.agents.list(pageOptions(rest));
        writeResult(stdout, json, page, formatPage(page.items, "agentId", page.cursor));
        return 0;
      }
      if (group === "tools" && action === "list") {
        const page = await client.tools.list(pageOptions(rest));
        writeResult(stdout, json, page, formatPage(page.items, "toolId", page.cursor));
        return 0;
      }
      const resourceId = positional(rest)[0];
      if (!resourceId) throw new CliError(2, "resource_id_required", `${group} get requires an ID`);
      const value = group === "agents"
        ? await client.agents.get(resourceId)
        : await client.tools.get(resourceId);
      writeResult(stdout, json, value, `${JSON.stringify(value, null, 2)}\n`);
      return 0;
    }

    throw new CliError(2, "unknown_command", `Unknown command: ${args.join(" ")}`);
  } catch (error) {
    const normalized = normalizeError(error);
    if (json) {
      stdout.write(`${JSON.stringify({ schemaVersion: 1, error: normalized })}\n`);
    } else {
      stderr.write(`Error [${normalized.code}]: ${normalized.message}\n`);
    }
    return normalized.exitCode;
  }
}

async function runSkills(
  action: string | undefined,
  args: string[],
  context: { stdout: Writable; stderr: Writable; json: boolean; homeDirectory?: string },
): Promise<number> {
  const catalog = await loadCatalog();
  if (action === "list") {
    writeResult(
      context.stdout,
      context.json,
      { packageVersion: catalog.packageVersion, skills: catalog.skills.map(({ path: _path, sha256: _sha256, ...skill }) => skill) },
      catalog.skills.map((skill) => `${skill.name}\t${skill.description}`).join("\n") + "\n",
    );
    return 0;
  }
  if (action === "get") {
    const name = positional(args)[0];
    if (!name) throw new CliError(2, "skill_name_required", "skills get requires a skill name");
    const skill = catalog.skills.find((candidate) => candidate.name === name);
    if (!skill) throw new CliError(2, "skill_not_found", `Unknown skill: ${name}`);
    const content = await verifiedSkillContent(skill);
    if (context.json) {
      writeResult(context.stdout, true, { name, packageVersion: catalog.packageVersion, content }, "");
    } else {
      context.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    }
    return 0;
  }
  if (action === "install") {
    const target = option(args, "--target") ?? "codex";
    const explicitPath = option(args, "--path");
    const destination = explicitPath ?? defaultSkillDestination(target, context.homeDirectory ?? homedir());
    context.stderr.write(`Install Use Agent discovery skill at ${destination}\n`);
    if (!args.includes("--yes")) {
      throw new CliError(2, "confirmation_required", "Re-run with --yes after reviewing the destination");
    }
    const outputPath = join(destination, "SKILL.md");
    if (!args.includes("--force") && await exists(outputPath)) {
      throw new CliError(5, "skill_exists", `Skill already exists at ${outputPath}; use --force to replace it`);
    }
    const source = await readFile(new URL("../skills/use-agent/SKILL.md", import.meta.url), "utf8");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, source, { encoding: "utf8", mode: 0o644 });
    writeResult(context.stdout, context.json, { target, path: outputPath }, `Installed ${outputPath}\n`);
    return 0;
  }
  throw new CliError(2, "unknown_command", "Use skills list, skills get <name>, or skills install");
}

async function authenticatedClient(
  environment: Record<string, string | undefined>,
  dependencies: Parameters<typeof loadAuthenticatedCliToken>[0],
) {
  const apiKey = environment.CODESPRING_AGENTS_API_KEY?.trim();
  if (apiKey) {
    return createClient({
      endpoint: environment.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_ENDPOINT,
      apiKey,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
  }
  const login = await loadAuthenticatedCliToken(dependencies);
  if (!login) {
    throw new CliError(
      3,
      "authentication_required",
      "Run use-agent auth login, or set CODESPRING_AGENTS_API_KEY for CI",
    );
  }
  return createClient({
    endpoint: login.auth.runtimeEndpoint,
    apiKey: login.token,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
}

function authDependencies(
  dependencies: CliDependencies,
  environment: Record<string, string | undefined>,
  stderr: Writable,
) {
  return {
    env: environment,
    stderr,
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    ...(dependencies.openBrowser === undefined
      ? {}
      : { openBrowser: dependencies.openBrowser }),
    ...(dependencies.credentialStore === undefined
      ? {}
      : { credentialStore: dependencies.credentialStore }),
  };
}

function pageOptions(args: string[]) {
  const rawLimit = option(args, "--limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CliError(2, "invalid_limit", "--limit must be an integer between 1 and 100");
  }
  const cursor = option(args, "--cursor");
  return cursor === undefined ? { limit } : { limit, cursor };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError(2, "option_value_required", `${name} requires a value`);
  return value;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith("--")) {
      if (!["--json", "--yes", "--force"].includes(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

async function loadCatalog(): Promise<SkillCatalog> {
  const raw = await readFile(new URL("../skills/catalog.json", import.meta.url), "utf8");
  return JSON.parse(raw) as SkillCatalog;
}

async function verifiedSkillContent(skill: SkillCatalog["skills"][number]): Promise<string> {
  const url = new URL(`../skills/${skill.path}`, import.meta.url);
  const content = await readFile(url, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== skill.sha256) throw new CliError(6, "skill_integrity_failed", `Bundled skill ${skill.name} failed integrity verification`);
  return content;
}

function defaultSkillDestination(target: string, home: string): string {
  const roots: Record<string, string> = {
    codex: join(home, ".codex", "skills", "use-agent"),
    claude: join(home, ".claude", "skills", "use-agent"),
    cursor: join(home, ".cursor", "skills", "use-agent"),
    ferb: join(home, ".ferb", "skills", "use-agent"),
  };
  const destination = roots[target];
  if (!destination) throw new CliError(2, "invalid_target", "--target must be codex, claude, cursor, or ferb; use --path for another client");
  return destination;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatPage<T extends object>(items: T[], idField: string, cursor: string | null): string {
  const lines = items.map((item) => {
    const record = item as Record<string, unknown>;
    return `${String(record[idField] ?? "")}\t${String(record.displayName ?? "")}\t${String(record.status ?? "")}`;
  });
  if (cursor) lines.push(`Next cursor: ${cursor}`);
  return lines.length ? `${lines.join("\n")}\n` : "No resources found.\n";
}

function writeResult(stdout: Writable, json: boolean, data: unknown, human: string): void {
  stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, data })}\n` : human);
}

class CliError extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function normalizeError(error: unknown): { exitCode: number; code: string; message: string; requestId?: string } {
  if (error instanceof CliError) return { exitCode: error.exitCode, code: error.code, message: error.message };
  if (error instanceof CliAuthError) return { exitCode: 3, code: error.code, message: error.message };
  if (error instanceof AgentError) {
    const exitCode = error.status === 401 ? 3 : error.status === 403 ? 4 : error.status === 409 ? 5 : error.status >= 500 ? 6 : 2;
    return { exitCode, code: error.code, message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) };
  }
  return { exitCode: 6, code: "unexpected_error", message: error instanceof Error ? error.message : String(error) };
}

const helpText = `Use Agent CLI

Usage:
  use-agent chatgpt status|models [--json]
  use-agent chatgpt connect|disconnect --yes [--json]
  use-agent capabilities [--json]
  use-agent sessions create --agent ID@REVISION [--harness native_v1|codex_wasm_v1] [--chatgpt-model ID --chatgpt-grant ID] --yes [--json]
  use-agent sessions get <session-id> [--json]
  use-agent sessions submit <session-id> --message TEXT --idempotency-key KEY --yes [--json]
  use-agent sessions events <session-id> [--after CURSOR] [--json]
  use-agent sessions cancel <session-id> --turn TURN_ID --yes [--json]
  use-agent workspace list <session-id> [--json]
  use-agent workspace read <session-id> --path PATH [--json]
  use-agent auth login [--no-browser] [--tenant ID|SLUG] [--environment ID|SLUG]
  use-agent auth status [--json]
  use-agent auth logout [--json]
  use-agent agents list [--limit N] [--cursor CURSOR] [--json]
  use-agent agents get <agent-id> [--json]
  use-agent tools list [--limit N] [--cursor CURSOR] [--json]
  use-agent tools get <tool-id> [--json]
  use-agent models discover --connection ID [--query TEXT] [--limit N] [--cursor CURSOR] [--refresh] [--json]
  use-agent models validate --connection ID --model MODEL [--json]
  use-agent skills list [--json]
  use-agent skills get <name> [--json]
  use-agent skills install [--target codex|claude|cursor|ferb] [--path PATH] --yes [--force]
  use-agent doctor [--json]

Environment:
  CODESPRING_AGENTS_API_KEY   Server/CI credential (never pass it as an argument)
  CODESPRING_AGENTS_ENDPOINT  Hosted or self-hosted runtime endpoint
`;

function validateWorkspaceOptions(args: string[], allowed: string[]) {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--")) continue;
    if (!allowed.includes(value)) throw new CliError(2, "unsupported_option", "Unsupported option for this command; see use-agent help");
    if (value !== "--json" && value !== "--yes") { option(args, value); index++; }
  }
}

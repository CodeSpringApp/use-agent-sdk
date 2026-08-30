import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AgentError, createClient } from "./client";

type Writable = { write(chunk: string): unknown };

export interface CliDependencies {
  stdout?: Writable;
  stderr?: Writable;
  env?: Record<string, string | undefined>;
  homeDirectory?: string;
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

    if (group === "auth" && action === "status") {
      const apiKeyConfigured = Boolean(environment.CODESPRING_AGENTS_API_KEY?.trim());
      const data = {
        authenticated: apiKeyConfigured,
        method: apiKeyConfigured ? "api_key_environment" : null,
        endpoint: environment.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_ENDPOINT,
      };
      writeResult(stdout, json, data, apiKeyConfigured
        ? `Authenticated through CODESPRING_AGENTS_API_KEY\nEndpoint: ${data.endpoint}\n`
        : "Not authenticated. Set CODESPRING_AGENTS_API_KEY for headless use. Browser login is not available in this release.\n");
      return apiKeyConfigured ? 0 : 3;
    }

    if (group === "doctor") {
      const catalog = await loadCatalog();
      const data = {
        node: process.version,
        endpoint: environment.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_ENDPOINT,
        apiKeyConfigured: Boolean(environment.CODESPRING_AGENTS_API_KEY?.trim()),
        skillCatalogVersion: catalog.packageVersion,
        skillCount: catalog.skills.length,
      };
      writeResult(stdout, json, data, `Runtime endpoint: ${data.endpoint}\nAPI key: ${data.apiKeyConfigured ? "configured" : "not configured"}\nSkills: ${data.skillCount} (${data.skillCatalogVersion})\n`);
      return data.apiKeyConfigured ? 0 : 3;
    }

    if ((group === "agents" || group === "tools") && (action === "list" || action === "get")) {
      const client = authenticatedClient(environment);
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

function authenticatedClient(environment: Record<string, string | undefined>) {
  const apiKey = environment.CODESPRING_AGENTS_API_KEY?.trim();
  if (!apiKey) {
    throw new CliError(3, "authentication_required", "Set CODESPRING_AGENTS_API_KEY; credentials are not accepted as command arguments");
  }
  return createClient({
    endpoint: environment.CODESPRING_AGENTS_ENDPOINT ?? DEFAULT_ENDPOINT,
    apiKey,
  });
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
  if (error instanceof AgentError) {
    const exitCode = error.status === 401 ? 3 : error.status === 403 ? 4 : error.status === 409 ? 5 : error.status >= 500 ? 6 : 2;
    return { exitCode, code: error.code, message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) };
  }
  return { exitCode: 6, code: "unexpected_error", message: error instanceof Error ? error.message : String(error) };
}

const helpText = `Use Agent CLI

Usage:
  use-agent auth status [--json]
  use-agent agents list [--limit N] [--cursor CURSOR] [--json]
  use-agent agents get <agent-id> [--json]
  use-agent tools list [--limit N] [--cursor CURSOR] [--json]
  use-agent tools get <tool-id> [--json]
  use-agent skills list [--json]
  use-agent skills get <name> [--json]
  use-agent skills install [--target codex|claude|cursor|ferb] [--path PATH] --yes [--force]
  use-agent doctor [--json]

Environment:
  CODESPRING_AGENTS_API_KEY   Server/CI credential (never pass it as an argument)
  CODESPRING_AGENTS_ENDPOINT  Hosted or self-hosted runtime endpoint
`;

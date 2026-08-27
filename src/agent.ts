import type { AgentDefinition, CreateAgentOptions } from "./types";

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

function requireIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!identifierPattern.test(normalized)) {
    throw new TypeError(`${name} must match ${identifierPattern.source}`);
  }
  return normalized;
}

function uniqueNames(values: readonly { name: string }[], name: string): void {
  const normalized = values.map((value) => value.name.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${name} names must be unique`);
  }
}

/** Defines a portable agent revision without importing runtime implementation code. */
export function createAgent(options: CreateAgentOptions): AgentDefinition {
  const id = requireIdentifier(options.id, "id");
  const revision = requireIdentifier(options.revision, "revision");
  const tools = (options.tools ?? []).map((tool) => ({ ...tool, name: tool.name.trim() }));
  uniqueNames(tools, "tool");

  return Object.freeze({
    id,
    revision,
    revisionId: `${id}@${revision}`,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.model === undefined ? {} : { model: Object.freeze({ ...options.model }) }),
    tools: Object.freeze(tools.map((tool) => Object.freeze(tool))),
    mcpServers: Object.freeze((options.mcpServers ?? []).map((server) => Object.freeze({ ...server }))),
    skills: Object.freeze((options.skills ?? []).map((skill) => Object.freeze({ ...skill }))),
    metadata: Object.freeze({ ...(options.metadata ?? {}) }),
  });
}

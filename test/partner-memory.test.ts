import { describe, expect, it } from "bun:test";
import { createUserMemoryService, type UserMemoryAdminStore,
  type UserMemoryItem, type UserMemoryNamespace } from "../src/partner-tools";
import { CustomerToolError } from "../src/tools";

const namespace = (subjectId: string): UserMemoryNamespace => ({
  accountId: "partner-1", workspaceId: "merchant-1", subjectId,
});
const key = (value: UserMemoryNamespace, id: string) =>
  `${value.accountId}:${value.workspaceId}:${value.subjectId}:${id}`;
const request = (subjectId: string) => new Request("https://partner.example.test/my-memory", {
  headers: { "X-Test-Subject": subjectId },
});

describe("partner-owned memory service", () => {
  it("confirms exact content once, scopes reads, and forgets the pinned revision", async () => {
    const proposals = new Map([[key(namespace("user-a"), "proposal-1"), {
      namespace: namespace("user-a"), id: "proposal-1", revision: "1",
      content: "Remember my preferred language is Welsh", status: "pending" as const,
    }]]);
    const items = new Map<string, UserMemoryItem>();
    const commits = new Map<string, UserMemoryItem>();
    const forgotten = new Set<string>();
    const consent = new Set(["user-a", "user-b"]);
    let commitCalls = 0;
    let successfulWrites = 0;
    const store: UserMemoryAdminStore = {
      async getProposal({ namespace: subject, proposalId }) {
        return proposals.get(key(subject, proposalId)) ?? null;
      },
      async commitApproved(input) {
        commitCalls += 1;
        const replay = commits.get(input.operationId);
        if (replay) return replay;
        const proposal = proposals.get(key(input.namespace, input.proposalId));
        if (!proposal || proposal.revision !== input.expectedRevision ||
            await sha256(proposal.content) !== input.expectedContentDigest)
          throw new CustomerToolError("memory_proposal_changed", "Memory proposal changed");
        if (items.size >= input.limits.maxItems ||
            successfulWrites >= input.limits.maxWritesPerDay ||
            new TextEncoder().encode(proposal.content).byteLength > input.limits.maxItemBytes)
          throw new CustomerToolError("memory_limit_reached", "Memory limit reached");
        const item = { id: "memory-1", revision: "1", content: proposal.content };
        items.set(key(input.namespace, item.id), item);
        proposals.delete(key(input.namespace, input.proposalId));
        commits.set(input.operationId, item);
        successfulWrites += 1;
        return item;
      },
      async list({ namespace: subject }) {
        return { items: [...items].filter(([id]) => id.startsWith(
          `${subject.accountId}:${subject.workspaceId}:${subject.subjectId}:`))
          .map(([, item]) => item), cursor: null };
      },
      async forget(input) {
        if (forgotten.has(input.operationId)) return;
        const stored = items.get(key(input.namespace, input.id));
        if (!stored || stored.revision !== input.expectedRevision)
          throw new CustomerToolError("memory_revision_changed", "Memory changed");
        items.delete(key(input.namespace, input.id));
        forgotten.add(input.operationId);
      },
    };
    const service = createUserMemoryService({
      limits: { maxItems: 1, maxWritesPerDay: 1, maxStoredBytes: 4096, maxItemBytes: 4096 },
      async resolveUser(userRequest) {
        const subjectId = userRequest.headers.get("X-Test-Subject");
        return subjectId ? namespace(subjectId) : null;
      },
      async authorize({ namespace: subject }) {
        if (!consent.has(subject.subjectId))
          throw new CustomerToolError("memory_disabled", "Memory is disabled");
      },
      store,
    });
    const pending = await service.getProposal(request("user-a"), "proposal-1");
    expect(pending).toMatchObject({ content: "Remember my preferred language is Welsh",
      revision: "1", audience: "personal" });
    await expect(service.getProposal(request("user-b"), "proposal-1"))
      .rejects.toMatchObject({ code: "memory_proposal_unavailable" });
    const operationId = "00000000-0000-4000-8000-000000000001";
    await expect(service.confirm(request("user-a"), { proposalId: "proposal-1",
      expectedRevision: pending.revision, expectedContentDigest: "0".repeat(64), operationId }))
      .rejects.toMatchObject({ code: "memory_proposal_changed" });
    const confirmation = { proposalId: "proposal-1", expectedRevision: pending.revision,
      expectedContentDigest: pending.contentDigest, operationId };
    const saved = await service.confirm(request("user-a"), confirmation);
    expect(saved).toEqual({ id: "memory-1", revision: "1", content: pending.content });
    expect(await service.confirm(request("user-a"), confirmation)).toEqual(saved);
    expect(commitCalls).toBe(3);
    proposals.set(key(namespace("user-a"), "proposal-2"), {
      namespace: namespace("user-a"), id: "proposal-2", revision: "1",
      content: "Another fact", status: "pending",
    });
    const second = await service.getProposal(request("user-a"), "proposal-2");
    await expect(service.confirm(request("user-a"), { proposalId: "proposal-2",
      expectedRevision: second.revision, expectedContentDigest: second.contentDigest,
      operationId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: "memory_limit_reached" });
    expect((await service.list(request("user-a"))).items).toEqual([saved]);
    expect((await service.list(request("user-b"))).items).toEqual([]);
    await expect(service.forget(request("user-b"), { id: saved.id,
      expectedRevision: saved.revision, operationId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: "memory_revision_changed" });
    const forget = { id: saved.id, expectedRevision: saved.revision,
      operationId: crypto.randomUUID() };
    expect(await service.forget(request("user-a"), forget))
      .toEqual({ id: saved.id, status: "forgotten" });
    expect(await service.forget(request("user-a"), forget))
      .toEqual({ id: saved.id, status: "forgotten" });
    expect((await service.list(request("user-a"))).items).toEqual([]);
    await expect(service.confirm(request("user-a"), { proposalId: "proposal-2",
      expectedRevision: second.revision, expectedContentDigest: second.contentDigest,
      operationId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: "memory_limit_reached" });
    consent.delete("user-a");
    await expect(service.list(request("user-a")))
      .rejects.toMatchObject({ code: "memory_disabled" });
  });
});

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

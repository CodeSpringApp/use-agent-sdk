import { describe, expect, test } from "bun:test";
import { AgentEventBuffer, type AgentEvent } from "../src";

describe("durable event buffer", () => {
  test("deduplicates replay/live overlap while advancing one contiguous cursor", () => {
    const buffer = new AgentEventBuffer();
    expect(buffer.merge([event(1), event(2)])).toMatchObject({
      accepted: [event(1), event(2)],
      duplicateIds: [],
    });
    expect(buffer.merge([event(2), event(3)])).toMatchObject({
      accepted: [event(3)],
      duplicateIds: [2],
    });
    expect(buffer.cursor).toBe(3);
    expect(buffer.events.map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  test("stops at a gap so a caller can recover the missing suffix", () => {
    const buffer = new AgentEventBuffer();
    buffer.merge([event(1)]);
    const result = buffer.merge([event(3), event(4)]);

    expect(result).toEqual({
      accepted: [],
      duplicateIds: [],
      gap: { expected: 2, received: 3 },
    });
    expect(buffer.cursor).toBe(1);
    expect(buffer.events.map(({ id }) => id)).toEqual([1]);

    expect(buffer.merge([event(2), event(3), event(4)]).gap).toBeUndefined();
    expect(buffer.cursor).toBe(4);
  });
});

function event(id: number): AgentEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: "session-1",
    attempt: 1,
    type: "message.delta",
    createdAt: "2026-08-30T00:00:00.000Z",
    data: { delta: String(id) },
  };
}

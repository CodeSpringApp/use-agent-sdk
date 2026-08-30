import type { AgentEvent } from "./types";

export interface AgentEventMergeResult {
  accepted: AgentEvent[];
  duplicateIds: number[];
  gap?: { expected: number; received: number };
}

/** Maintains the single contiguous durable cursor used by replay and live delivery. */
export class AgentEventBuffer {
  private ordered: AgentEvent[] = [];
  private currentCursor = 0;

  get cursor(): number {
    return this.currentCursor;
  }

  get events(): readonly AgentEvent[] {
    return this.ordered;
  }

  merge(incoming: readonly AgentEvent[]): AgentEventMergeResult {
    const accepted: AgentEvent[] = [];
    const duplicateIds: number[] = [];
    for (const event of incoming) {
      if (event.id <= this.currentCursor) {
        duplicateIds.push(event.id);
        continue;
      }
      const expected = this.currentCursor + 1;
      if (event.id !== expected) {
        return { accepted, duplicateIds, gap: { expected, received: event.id } };
      }
      this.ordered.push(event);
      this.currentCursor = event.id;
      accepted.push(event);
    }

    return { accepted, duplicateIds };
  }

  reset(): void {
    this.ordered = [];
    this.currentCursor = 0;
  }
}

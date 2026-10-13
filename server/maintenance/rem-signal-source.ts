/** Production measurements for the issue-#391 REM eligibility decision. */
import { freemem } from "node:os";
import type pg from "pg";
import { createRemSignalRepository } from "../db/rem-signal-repository.ts";
import type { RemEligibilitySignals } from "./maintenance-sweep.ts";

const RATE_WINDOW_MS = 60_000;

export interface RemSignalSource {
  observeMcpRequest(): void;
  read(): Promise<RemEligibilitySignals>;
}

export interface RemSignalSourceOptions {
  readonly now?: () => number;
  readonly freeMemory?: () => number;
}

interface RequestTimeNode {
  readonly atMs: number;
  next?: RequestTimeNode;
}

/**
 * Combine process-local request arrivals and memory headroom with durable
 * database facts. Timestamps are retained for one rate window and pruned on
 * both writes and reads, so request traffic cannot grow this process state
 * without bound.
 */
export function createRemSignalSource(
  pool: pg.Pool,
  options: RemSignalSourceOptions = {},
): RemSignalSource {
  const now = options.now ?? Date.now;
  const freeMemory = options.freeMemory ?? freemem;
  const schedulerStartedAtMs = now();
  let oldestRequest: RequestTimeNode | undefined;
  let newestRequest: RequestTimeNode | undefined;
  let requestCount = 0;
  const repository = createRemSignalRepository(pool);

  const prune = (atMs: number): void => {
    const cutoff = atMs - RATE_WINDOW_MS;
    while (oldestRequest && oldestRequest.atMs < cutoff) {
      oldestRequest = oldestRequest.next;
      requestCount -= 1;
    }
    if (!oldestRequest) newestRequest = undefined;
  };

  return {
    observeMcpRequest(): void {
      const atMs = now();
      prune(atMs);
      const request = { atMs };
      if (newestRequest) newestRequest.next = request;
      else oldestRequest = request;
      newestRequest = request;
      requestCount += 1;
    },
    async read(): Promise<RemEligibilitySignals> {
      const nowMs = now();
      prune(nowMs);
      const facts = await repository.readFacts();
      return {
        nowMs,
        schedulerStartedAtMs,
        lastRemCompletedAtMs: facts.last_rem_completed_at?.getTime() ?? null,
        requestsPerMinute: requestCount,
        headroomBytes: freeMemory(),
        lightBacklog: Number(facts.light_backlog),
      };
    },
  };
}

/**
 * Fake transport and fixture plumbing for `scenario-gate.test.ts`.
 *
 * Split out of the test file so each factory stays under the shared
 * max-lines-per-function bound and `executeProvider` can dispatch through
 * small named branches instead of one over-complex closure (issue 752).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenarioFixture } from "../scenario-fixtures.ts";
import { parseProviderOutput } from "../scenario-transport.ts";
import type {
  ProviderExecution,
  ScenarioFixture,
  ScenarioRecord,
  ScenarioTransport,
  TeardownResidue,
  TeardownTally,
} from "../scenario-types.ts";

export const FIXTURE: ScenarioFixture = parseScenarioFixture(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/scenarios-v1.json"),
      "utf8",
    ),
  ),
);

export interface FakeOptions {
  zeroWrite?: boolean;
  emptyProviderOutput?: boolean;
  /** Raw stderr a failing capture child writes before dying (issue #583). */
  captureStderr?: string;
  /** Exit code for that failing capture child. */
  captureExitCode?: number;
  /** Stdout for that failing capture child; defaults to empty. */
  captureStdout?: string;
  lostCapture?: boolean;
  ignoredKeys?: string[];
  packCharLimit?: number;
  packItems?: Array<Record<string, unknown>>;
  packItemCount?: number;
  packThrows?: boolean;
  cleanupFails?: number;
  /**
   * Rows the fake transport reports as REMAINING after cleanup (#671). Distinct
   * from `cleanupFails`, which is calls that threw -- keeping them separate is
   * the whole point of the issue: a thrown call is not a stranded row.
   */
  residueRows?: number;
  /** Report the residue observation as never having run (#671). */
  residueUnchecked?: boolean;
}

interface LaneState {
  id: string;
  current_context_md: string | null;
  events: Array<{ id: string; content: string }>;
}

/** Monotonic id source shared by one fake transport instance. */
type NextId = (prefix: string) => string;

function makeExecution(
  opts: FakeOptions,
  operation: string,
  result: Record<string, unknown>,
): ProviderExecution {
  const lost = operation === "capture" && opts.lostCapture;
  return {
    exitCode: 0,
    receipt: {
      operation,
      status: lost ? "lost" : "saved",
      durable: !lost,
      direct_attempted: true,
      fallback_attempted: false,
      ignored_optional_request_keys: opts.ignoredKeys,
    },
    result,
  };
}

/**
 * The capture branches that bypass the receipt builder entirely, returning a
 * value parsed by the REAL provider parser so the test exercises the
 * production stderr/empty-output paths. `undefined` means "not one of these".
 */
function captureParserBranch(opts: FakeOptions): ProviderExecution | undefined {
  if (opts.emptyProviderOutput) return parseProviderOutput("", 0);
  if (opts.captureStderr !== undefined) {
    return parseProviderOutput(
      opts.captureStdout ?? "",
      opts.captureExitCode ?? 1,
      opts.captureStderr,
    );
  }
  return undefined;
}

function handleCapture(
  opts: FakeOptions,
  lane: LaneState,
  content: unknown,
  nextId: NextId,
): ProviderExecution {
  const parsed = captureParserBranch(opts);
  if (parsed !== undefined) return parsed;
  if (!opts.zeroWrite && !opts.lostCapture) {
    lane.events.push({ id: nextId("event"), content: String(content) });
  }
  return makeExecution(opts, "capture", {
    event_id: lane.events.at(-1)?.id,
    lane_id: lane.id,
  });
}

function handleCheckpoint(
  opts: FakeOptions,
  lane: LaneState,
  call: { operation: string; summary: unknown },
  nextId: NextId,
): ProviderExecution {
  lane.current_context_md = String(call.summary);
  return makeExecution(opts, call.operation, {
    session_id: nextId("session"),
    lane_id: lane.id,
  });
}

function fakeContextPack(opts: FakeOptions) {
  if (opts.packThrows) throw new Error("synthetic pack failure");
  const items = opts.packItems ?? [{ id: "memory-1", citation_id: "citation-1" }];
  const sections = {
    durable_memory: {
      label: "durable_memory",
      namespace_scoped: true,
      items,
      item_count: opts.packItemCount ?? items.length,
      truncated: false,
    },
  };
  const serialized = JSON.stringify(sections).length;
  return {
    status: "ok",
    sections,
    budget: {
      whole_pack: { content_char_limit: opts.packCharLimit ?? serialized },
    },
  };
}

function fakeResidue(opts: FakeOptions): TeardownResidue {
  if (opts.residueUnchecked) {
    return {
      checked: false,
      rows: 0,
      by_table: {},
      unchecked_reason: "fake transport reported no observation",
    };
  }
  const rows = opts.residueRows ?? 0;
  return {
    checked: true,
    rows,
    by_table: rows > 0 ? { thoughts: rows } : {},
  };
}

function fakeCleanup(
  opts: FakeOptions,
  records: ScenarioRecord[],
): { tally: TeardownTally; residue: TeardownResidue } {
  const failed = Math.min(opts.cleanupFails ?? 0, records.length);
  return {
    tally: {
      attempted: records.length,
      archived: records.length - failed,
      already_absent: 0,
      failed,
      failure_labels: Array.from(
        { length: failed },
        (_unused, index) => `fake_cleanup:threw-${index}`,
      ),
    },
    residue: fakeResidue(opts),
  };
}

export function fakeTransport(opts: FakeOptions = {}): ScenarioTransport {
  const lanes = new Map<string, LaneState>();
  let sequence = 0;
  const nextId: NextId = (prefix) => `${prefix}-${++sequence}`;

  const laneFor = (sessionKey: string): LaneState => {
    const lane = lanes.get(sessionKey) ?? {
      id: nextId("lane"),
      current_context_md: null,
      events: [],
    };
    lanes.set(sessionKey, lane);
    return lane;
  };

  return {
    async executeProvider(request) {
      const operation = String(request.operation);
      const scope = request.scope as { session_key: string };
      const lane = laneFor(scope.session_key);
      return operation === "capture"
        ? handleCapture(opts, lane, request.content, nextId)
        : handleCheckpoint(opts, lane, { operation, summary: request.summary }, nextId);
    },
    async logMemory() {
      return { id: nextId("memory") };
    },
    async contextPack() {
      return fakeContextPack(opts);
    },
    async sessionContext({ sessionKey }) {
      const lane = lanes.get(sessionKey);
      return lane
        ? { lane, events: lane.events, event_count: lane.events.length }
        : { lane: null, events: [], event_count: 0 };
    },
    async cleanup(records: ScenarioRecord[]) {
      return fakeCleanup(opts, records);
    },
    async close() {},
  };
}

import { describe, expect, it } from "vitest";
import { runLiveGate } from "../gate.ts";
import { LiveTransportError, OpenBrainLiveClient } from "../transport.ts";
import { expectTransportError } from "./transport-test-support.ts";
import {
  CONFIG,
  FIXTURE,
  THRESHOLDS,
  ok,
  scriptedCaller,
} from "./gate-test-support.ts";

describe("runLiveGate through the REAL transport parseHits boundary", () => {
  // The fakes in gate.test.ts stub search at the OpenBrainLiveClient level, so
  // they never exercise parseHits. This test wires a REAL primary
  // OpenBrainLiveClient over a scripted tool caller, so the search body flows
  // through the actual parseHits transport boundary and into the gate. It proves
  // the end-to-end seam: a hit that is a valid object with a string id but NO
  // namespace survives parseHits (namespace is optional there) and reaches the
  // gate, which fails it closed as foreign-namespace -- not silently dropped at
  // either layer.

  it("a valid namespace-less hit passes parseHits and fails at the gate as foreign-namespace", async () => {
    const primaryNs = CONFIG.primaryNamespace;
    // Seed responses: log_thought / log_decision return fresh creates under the
    // primary namespace so the seed map is populated for prim-a and prim-b.
    // The single probe search then returns the two seeded ids (with namespace)
    // PLUS one valid hit that has a string id but NO namespace field.
    const primary = new OpenBrainLiveClient(
      scriptedCaller({
        log_thought: [
          ok(
            JSON.stringify({
              id: "srv-prim-a",
              namespace: primaryNs,
              merged: false,
            }),
          ),
        ],
        log_decision: [
          ok(
            JSON.stringify({
              id: "srv-prim-b",
              namespace: primaryNs,
              merged: false,
            }),
          ),
        ],
        search_brain: [
          ok(
            JSON.stringify([
              {
                id: "srv-prim-a",
                source_type: "thoughts",
                namespace: primaryNs,
              },
              {
                id: "srv-prim-b",
                source_type: "decisions",
                namespace: primaryNs,
              },
              // Valid object, string id, NO namespace: survives parseHits, then
              // the gate must fail it closed as foreign-namespace.
              { id: "srv-no-ns", source_type: "thoughts" },
            ]),
          ),
        ],
        // Teardown archives the two primary records (bound to id+table).
        archive_entry: [
          ok(
            JSON.stringify({
              id: "srv-prim-a",
              table: "thoughts",
              archived: true,
            }),
          ),
          ok(
            JSON.stringify({
              id: "srv-prim-b",
              table: "decisions",
              archived: true,
            }),
          ),
        ],
      }),
    );

    // The negative client only needs to seed its one record and archive it; its
    // namespace read is never reached because the primary search fails first.
    const negative = new OpenBrainLiveClient(
      scriptedCaller({
        log_thought: [
          ok(
            JSON.stringify({
              id: "srv-neg-secret",
              namespace: CONFIG.negativeNamespace,
              merged: false,
            }),
          ),
        ],
        archive_entry: [
          ok(
            JSON.stringify({
              id: "srv-neg-secret",
              table: "thoughts",
              archived: true,
            }),
          ),
        ],
      }),
    );

    const err = expectTransportError(
      await runLiveGate({
        fixture: FIXTURE,
        thresholds: THRESHOLDS,
        config: CONFIG,
        clients: { primary, negative },
        commit: "testcommit",
        generatedAt: "2026-07-22T00:00:00.000Z",
      }).catch((e) => e as LiveTransportError),
    );

    expect(err).toBeInstanceOf(LiveTransportError);
    // parseHits kept the namespace-less hit (namespace optional), so the gate --
    // not the transport boundary -- classified it as foreign-namespace.
    expect(err.label).toBe("search_brain:foreign-namespace");
    expect(err.label).not.toContain("srv-no-ns");
  });
});

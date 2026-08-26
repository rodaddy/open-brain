/**
 * Capture liveness observer — the gatherer half of #652.
 *
 * The done-means check (`scripts/done-means/652-capture-health-composed.sh`)
 * proves the reading reaches a live `/health` through the real composition.
 * These tests cover what that check deliberately does not touch: the SQL fold
 * itself, where a dead speaker has NO ROWS and would be invisible without the
 * expected-role seed, and the failure paths that must not fabricate a verdict.
 *
 * The pool is a fake because the property under test is the fold, not
 * Postgres's grouping — and a fake is what lets the no-rows and query-throws
 * cases be driven at all.
 */
import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import { silentLogger } from "../transport/testing/silent-logger.ts";
import {
  createCaptureLivenessObserver,
  readCaptureLiveness,
  MIN_SESSIONS_FOR_SILENCE,
} from "./liveness-observer.ts";
import { EXPECTED_LIVE_ROLES } from "../domain/raw-turn-roles.ts";

function poolReturning(rows: ReadonlyArray<Record<string, unknown>>): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

function poolThrowing(): Pool {
  return {
    query: async () => {
      throw new Error("connection terminated");
    },
  } as unknown as Pool;
}

const WINDOW = { windowMinutes: 60, namespace: "rico" } as const;

function observer(pool: Pool) {
  return createCaptureLivenessObserver(
    { pool, logger: silentLogger(), window: WINDOW },
    { autoStart: false },
  );
}

describe("capture liveness observer", () => {
  it("reads a delivering lane as healthy", async () => {
    // All three ACCEPTED roles deliver. This fixture carried only user and
    // assistant until #681, which was not a statement that a healthy lane has
    // two speakers — it was the two-role seed showing through: `tool` could not
    // be judged, so its absence read as health. With the seed derived from the
    // accepted set, a healthy lane is one where every accepted role arrives.
    const subject = observer(
      poolReturning([
        { role: "user", turns: "120", sessions: "9", seconds_since_last: "4" },
        { role: "assistant", turns: "118", sessions: "9", seconds_since_last: "2" },
        { role: "tool", turns: "94", sessions: "9", seconds_since_last: "6" },
      ]),
    );
    await subject.refresh();
    const reading = subject.reading();

    expect(reading?.stale).toBe(false);
    expect(reading?.turns_delivered).toBe(332);
    expect(reading?.sessions_observed).toBe(9);
    expect(reading?.silent_roles).toEqual([]);
  });

  it("names a speaker that has NO ROWS at all as silent", async () => {
    // The #447 shape and the reason the expected-role seed exists: the dead
    // speaker produces no group, so a fold over returned rows alone would
    // report a busy lane. 365 user rows beside an absent assistant is exactly
    // the six-day blind spot (`capture-never-drops-a-turn.md:291`).
    //
    // This assertion has moved twice, and the history is the point. It read
    // `["assistant"]` originally; #681 widened it to `["assistant", "tool"]`
    // because a role missing from the seed could not be judged AT ALL; #685
    // narrowed it back — not by re-shrinking the seed, but by seeding from the
    // roles the LIVE LANE PRODUCES rather than the roles ingest ACCEPTS. `tool`
    // is absent here and that is correct and permanent: no live producer emits
    // it (records.py has no TOOL branch, deliberately), so naming it a fault
    // returned 503 from /health and rolled back every deploy.
    //
    // The #681 lesson is intact. A role that SHOULD arrive and does not is
    // still named — `assistant` here — and the seed is still derived from a
    // declared set rather than a literal beside an enum.
    const subject = observer(
      poolReturning([
        { role: "user", turns: "365", sessions: "9", seconds_since_last: "3" },
      ]),
    );
    await subject.refresh();
    const reading = subject.reading();

    expect(reading?.stale).toBe(true);
    expect(reading?.silent_roles).toEqual(["assistant"]);
    expect(reading?.turns_delivered).toBe(365);
    expect(reading?.reason).toContain("assistant");
  });

  it("names a dead SPOKEN role beside a live one (#681 mechanism, #685 scope)", async () => {
    // The #681 mechanism, preserved: a role that SHOULD be arriving and is not
    // must be named, not silently absent from the GROUP BY. What #685 corrected
    // is WHICH roles those are. The original of this test used a dead `tool`
    // role as the specimen, and that specimen was wrong: the live capture
    // parser has no TOOL branch by design, so `tool` is silent permanently and
    // correctly. Asserting a fault on it made /health return 503 forever and
    // rolled back every deploy.
    //
    // `assistant` is the right specimen. It has a live producer, so its silence
    // is real evidence of a broken lane -- which is what this module exists to
    // catch.
    const subject = observer(
      poolReturning([
        { role: "user", turns: "3780", sessions: "9", seconds_since_last: "12" },
      ]),
    );
    await subject.refresh();
    const reading = subject.reading();

    expect(reading?.silent_roles).toEqual(["assistant"]);
    expect(reading?.reason).toContain("assistant");
  });

  it("does NOT fault on a silent `tool` role, which has no live producer (#685)", async () => {
    // The regression this issue is about. Both spoken roles delivering and no
    // tool turns is the NORMAL live state -- verified 2026-08-25, newest tool
    // row 2026-08-01 with user and assistant flowing -- because the third
    // stream (reasoning, tool calls, tool output) ships to Langfuse rather than
    // through this lane. A fault here is a false 503.
    const subject = observer(
      poolReturning([
        { role: "user", turns: "3780", sessions: "9", seconds_since_last: "12" },
        { role: "assistant", turns: "58140", sessions: "9", seconds_since_last: "3" },
      ]),
    );
    await subject.refresh();
    const reading = subject.reading();

    expect(reading?.silent_roles).toEqual([]);
    expect(reading?.stale).toBe(false);
  });

  it("stays green when an accepted-but-unexpected role also delivers", async () => {
    // The control for the clauses above. `tool` is ACCEPTED (the bulk importer
    // emits it), just never EXPECTED of the live lane, so its arrival must be
    // counted and must not be treated as anomalous. An implementation that
    // narrowed the seed by filtering arrivals rather than by narrowing
    // EXPECTATIONS would drop these 900 turns from turns_delivered and fail
    // here.
    const subject = observer(
      poolReturning([
        { role: "user", turns: "300", sessions: "9", seconds_since_last: "12" },
        { role: "assistant", turns: "1200", sessions: "9", seconds_since_last: "3" },
        { role: "tool", turns: "900", sessions: "9", seconds_since_last: "5" },
      ]),
    );
    await subject.refresh();
    const reading = subject.reading();

    expect(reading?.stale).toBe(false);
    expect(reading?.silent_roles).toEqual([]);
    expect(reading?.turns_delivered).toBe(2400);
  });

  it("seeds every role the live lane produces, so a new one cannot escape", async () => {
    // The mechanism, not the instance (#681), rescoped by #685. The seed
    // derives from `EXPECTED_LIVE_ROLES`, so this asserts the observation's
    // keys ARE that set — a hardcoded pair would satisfy the behavioural tests
    // above and rebuild the identical trap for the next role the LIVE LANE
    // learns to emit.
    //
    // Deriving from the ACCEPT set instead is what #685 fixed: it made the
    // observer demand `tool`, which no live producer sends.
    // `raw-turn-roles.test.ts` pins live as a strict subset of accept, so the
    // two cannot silently converge again.
    const subject = observer(
      poolReturning([
        { role: "user", turns: "10", sessions: "9", seconds_since_last: "1" },
      ]),
    );
    await subject.refresh();

    expect(Object.keys(subject.observation()?.turnsByRole ?? {}).sort()).toEqual(
      [...EXPECTED_LIVE_ROLES].sort(),
    );
  });

  it("publishes nothing when the window holds no arrivals at all", async () => {
    // A fresh process or a quiet night is not a dead lane. Absence of evidence
    // must publish absence, not a verdict in either direction.
    const subject = observer(poolReturning([]));
    await subject.refresh();

    expect(subject.reading()).toBeUndefined();
  });

  it("keeps publishing nothing when the gather query fails", async () => {
    // A database hiccup is not evidence the capture lane died. Fabricating
    // `stale` here would train an operator to ignore the signal.
    const subject = observer(poolThrowing());
    await subject.refresh();

    expect(subject.reading()).toBeUndefined();
  });

  it("does not call a single quiet session a dead lane", () => {
    const reading = readCaptureLiveness({
      sessionsObserved: 1,
      watermarkBytesAdvanced: 0,
      spoolPending: 0,
      outageAnnouncements: 0,
      turnsByRole: { user: 0, assistant: 0 },
      silenceSeconds: 9_000,
    });

    expect(MIN_SESSIONS_FOR_SILENCE).toBe(2);
    expect(reading?.stale).toBe(false);
    expect(reading?.silent_roles).toEqual([]);
  });

  it("never reports the watermark as wedged from a lane that delivered turns", () => {
    // The gatherer substitutes delivered turns for bytes advanced because a
    // server cannot see the client-side watermark. If that substitution were
    // ever replaced by a literal 0, every healthy deployment would degrade —
    // this pins the property, not the units.
    const reading = readCaptureLiveness({
      sessionsObserved: 9,
      watermarkBytesAdvanced: 238,
      spoolPending: 0,
      outageAnnouncements: 0,
      turnsByRole: { user: 120, assistant: 118 },
      silenceSeconds: 1,
    });

    expect(reading?.watermark_wedged).toBe(false);
    expect(reading?.stale).toBe(false);
  });

  it("carries silence_seconds without deriving any verdict from it", () => {
    const reading = readCaptureLiveness({
      sessionsObserved: 9,
      watermarkBytesAdvanced: 238,
      spoolPending: 0,
      outageAnnouncements: 0,
      turnsByRole: { user: 120, assistant: 118 },
      silenceSeconds: 86_400,
    });

    // A full day of reported silence, and the verdict is still healthy: the
    // counts decide, the clock only describes (lane-contract round 5).
    expect(reading?.silence_seconds).toBe(86_400);
    expect(reading?.stale).toBe(false);
  });

  it("returns undefined for an absent observation rather than a healthy reading", () => {
    expect(readCaptureLiveness(undefined)).toBeUndefined();
  });

  describe("quarantined units are never a silent drop (#680)", () => {
    const delivering = {
      sessionsObserved: 4,
      watermarkBytesAdvanced: 240,
      spoolPending: 0,
      outageAnnouncements: 0,
      turnsByRole: { user: 120, assistant: 120 },
      silenceSeconds: 3,
    } as const;

    it("raises a named fault and publishes the count", () => {
      const reading = readCaptureLiveness({ ...delivering, spoolQuarantined: 3 });

      expect(reading?.stale).toBe(true);
      expect(reading?.quarantined_count).toBe(3);
      expect(reading?.reason).toContain("quarantined");
      // The words must state the consequence, because "3 quarantined" alone
      // reads like a queue depth an operator can wait out. These records are
      // gone until someone replays the sidecar by hand.
      expect(reading?.reason).toContain("operator");
    });

    it("reports a real zero when a vantage point looked and found none", () => {
      const reading = readCaptureLiveness({ ...delivering, spoolQuarantined: 0 });

      expect(reading?.stale).toBe(false);
      expect(reading?.quarantined_count).toBe(0);
      expect(reading?.reason).not.toContain("quarantined");
    });

    it("omits the count entirely when nothing reported one", () => {
      // The load-bearing distinction. A hardcoded 0 standing in for an
      // unmeasured quantity is the exact defect: on 2026-07-30 `/health` read
      // `spool_pending:0, reason:"capture lane delivering"` while fifteen turns
      // were already gone. "Nobody looked" must not render as "nothing wrong".
      const reading = readCaptureLiveness(delivering);

      expect(reading?.stale).toBe(false);
      expect(reading).not.toHaveProperty("quarantined_count");
    });

    it("fires below the silence quorum, unlike the liveness faults", () => {
      // Deliberately NOT gated on `active`. The other faults ask "is the lane
      // working right now?" and are meaningless on a quiet night; this one
      // reports that data is already lost, which is equally true at 3am. A
      // deployment that stopped capturing BECAUSE its records were being
      // abandoned is precisely the case a quorum gate would hide.
      const reading = readCaptureLiveness({
        ...delivering,
        sessionsObserved: MIN_SESSIONS_FOR_SILENCE - 1,
        spoolQuarantined: 2,
      });

      expect(reading?.stale).toBe(true);
      expect(reading?.quarantined_count).toBe(2);
    });

    it("reports every fault that fired, not just the first", () => {
      const reading = readCaptureLiveness({
        ...delivering,
        turnsByRole: { user: 120, assistant: 0 },
        spoolQuarantined: 1,
      });

      expect(reading?.stale).toBe(true);
      expect(reading?.silent_roles).toEqual(["assistant"]);
      expect(reading?.reason).toContain("quarantined");
      expect(reading?.reason).toContain("assistant");
    });

    it("leaves the gatherer reporting no quarantine count of its own", async () => {
      // The arrivals query genuinely cannot see a client-side sidecar, so the
      // gatherer must leave the field undefined rather than pass a confident 0
      // — the same honesty the module already applies to spool_pending.
      const observed = observer(
        poolReturning([
          { role: "user", turns: "12", sessions: "3", seconds_since_last: "4" },
        ]),
      );
      await observed.refresh();

      expect(observed.observation()).not.toHaveProperty("spoolQuarantined");
      expect(observed.reading()).not.toHaveProperty("quarantined_count");
    });
  });
});

/**
 * Tests for `apps/monitor/evaluator.ts`.
 *
 * WHY THIS FILE IS THE LONGEST TEST IN THE EXEMPLAR
 *
 * The evaluator holds every rule that will actually change: what counts as
 * healthy, how many failures make an outage, whether a slow 200 is degraded.
 * Rules that change are exactly the code that needs tests, and the reason the
 * module is pure is so those tests can be values-in / values-out with no server,
 * no clock, and no database.
 *
 * The flake-suppression logic (`failureThreshold`) gets the most attention here
 * because it is the part with real consequences in both directions: too eager
 * and one dropped packet pages somebody at 3am, too lax and a genuine outage
 * goes unreported. Both failure modes are asserted.
 */

import assert from "node:assert/strict";
import { describe as suite, test } from "node:test";

import {
  applyResult,
  classify,
  describe as describeStatus,
  initialState,
} from "../src/exemplar/apps/monitor/evaluator.ts";
import type {
  CheckResult,
  CheckTarget,
  TargetState,
} from "../src/exemplar/models/check.ts";

/**
 * A target with sane defaults, overridable per test.
 *
 * A builder rather than a shared constant: a shared mutable fixture is how one
 * test's tweak silently changes another's premise, and the resulting failure
 * points at the wrong test.
 */
function makeTarget(overrides: Partial<CheckTarget> = {}): CheckTarget {
  // Note there is no `intervalSeconds` here: the poll interval belongs to the
  // MONITOR, not to a target, and lives on MonitorSettings. Writing it here
  // compiled in neither direction -- tsc rejected the excess property outright,
  // which is `noUncheckedIndexedAccess`-adjacent strictness earning its keep on
  // a test fixture that would otherwise have quietly encoded a wrong model.
  return {
    name: "example",
    url: "https://example.test/health",
    timeoutMs: 5_000,
    expectStatus: [200],
    failureThreshold: 3,
    ...overrides,
  };
}

/**
 * A state that is known-healthy, typed as the general TargetState.
 *
 * `{ ...initialState(n), status: "up" as const }` narrows `status` to the
 * literal `"up"`, and `applyResult` returns a general `CheckStatus` -- so
 * reassigning its result to that narrowed variable is a type error. Building
 * the fixture through the real type avoids inventing a shape the code never
 * produces.
 */
function healthyState(name = "example"): TargetState {
  return { ...initialState(name), status: "up" };
}

/** A result with sane defaults, overridable per test. */
function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    targetName: "example",
    status: "up",
    statusCode: 200,
    durationMs: 12,
    error: null,
    recordedAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

suite("classify", () => {
  test("a transport error is down, whatever else is true", () => {
    // Checked FIRST, because a request that never landed has no meaningful
    // status code -- and a stale one from a previous attempt must not be read.
    assert.equal(classify(makeTarget(), null, "ECONNREFUSED"), "down");
    assert.equal(classify(makeTarget(), 200, "ETIMEDOUT"), "down");
  });

  test("no status and no error is unknown, not down", () => {
    // The distinction matters: "we could not tell" is not "it is broken", and
    // collapsing the two produces false outages during a monitoring restart.
    assert.equal(classify(makeTarget(), null, null), "unknown");
  });

  test("an unexpected status is degraded, not down", () => {
    // It answered. Something is wrong, but the process is alive and the
    // distinction changes who gets paged.
    assert.equal(classify(makeTarget(), 503, null), "degraded");
    assert.equal(classify(makeTarget(), 404, null), "degraded");
  });

  test("an expected status is up", () => {
    assert.equal(classify(makeTarget(), 200, null), "up");
  });

  test("expectStatus is honoured, not hardcoded to 200", () => {
    // A health endpoint returning 204, or an auth-gated one returning 401 by
    // design, is a real configuration. Hardcoding 200 is the bug this asserts
    // against.
    const target = makeTarget({ expectStatus: [204, 401] });
    assert.equal(classify(target, 204, null), "up");
    assert.equal(classify(target, 401, null), "up");
    assert.equal(classify(target, 200, null), "degraded");
  });
});

suite("initialState", () => {
  test("starts unknown with no history", () => {
    const state = initialState("example");
    assert.equal(state.targetName, "example");
    assert.equal(state.status, "unknown");
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.lastCheckedAt, null);
    assert.equal(state.lastOkAt, null);
  });

  test("starts unknown rather than up", () => {
    // Optimistic initialization is a real and damaging default: a monitor that
    // assumes health until proven otherwise reports everything green during the
    // window where it knows nothing, which is precisely startup after an
    // incident.
    assert.notEqual(initialState("example").status, "up");
  });
});

suite("applyResult -- flake suppression", () => {
  test("one failure does NOT flip a healthy target", () => {
    // The whole reason failureThreshold exists. Networks blip; one dropped
    // packet must not page anyone.
    const previous = healthyState();
    const next = applyResult(
      previous,
      makeTarget({ failureThreshold: 3 }),
      makeResult({ status: "down" }),
    );

    assert.equal(next.status, "up", "held its prior status");
    assert.equal(next.consecutiveFailures, 1, "but the failure was counted");
  });

  test("the threshold-th consecutive failure DOES flip it", () => {
    // The other direction, asserted just as explicitly: suppression that never
    // releases is an outage nobody hears about.
    const target = makeTarget({ failureThreshold: 3 });
    let state = healthyState();

    for (let i = 0; i < 3; i++) {
      state = applyResult(state, target, makeResult({ status: "down" }));
    }

    assert.equal(state.status, "down");
    assert.equal(state.consecutiveFailures, 3);
  });

  test("a single success resets the counter completely", () => {
    // Not decremented -- reset. A target that recovers is healthy now, and
    // carrying two-thirds of an old outage forward makes the NEXT blip page.
    const target = makeTarget({ failureThreshold: 3 });
    let state = applyResult(healthyState(), target, makeResult({ status: "down" }));
    assert.equal(state.consecutiveFailures, 1);

    state = applyResult(state, target, makeResult({ status: "up" }));
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.status, "up");
  });

  test("a threshold of 1 flips immediately", () => {
    // The boundary. `>=` rather than `>` in the implementation is what makes
    // this work, and it is exactly the comparison that gets written wrong.
    const next = applyResult(
      healthyState(),
      makeTarget({ failureThreshold: 1 }),
      makeResult({ status: "down" }),
    );
    assert.equal(next.status, "down");
  });
});

suite("applyResult -- timestamps", () => {
  test("lastOkAt advances only on success", () => {
    const target = makeTarget();
    const state = applyResult(
      healthyState(),
      target,
      makeResult({ status: "up", recordedAt: "2026-07-30T12:00:00.000Z" }),
    );
    assert.equal(state.lastOkAt, "2026-07-30T12:00:00.000Z");

    const afterFailure = applyResult(
      state,
      target,
      makeResult({ status: "down", recordedAt: "2026-07-30T12:01:00.000Z" }),
    );

    // lastCheckedAt moves, lastOkAt does not -- that gap IS the outage duration,
    // and overwriting lastOkAt on failure erases the only record of when it was
    // last healthy.
    assert.equal(afterFailure.lastCheckedAt, "2026-07-30T12:01:00.000Z");
    assert.equal(afterFailure.lastOkAt, "2026-07-30T12:00:00.000Z");
  });
});

suite("applyResult -- purity", () => {
  test("does not mutate the state it was given", () => {
    // The aliasing bug this guards against is invisible until two targets share
    // a state object and start reporting each other's failures.
    const previous = healthyState();
    const snapshot = JSON.stringify(previous);

    applyResult(previous, makeTarget(), makeResult({ status: "down" }));

    assert.equal(JSON.stringify(previous), snapshot, "input was mutated");
  });

  test("returns a new object, not the same reference", () => {
    const previous = initialState("example");
    const next = applyResult(previous, makeTarget(), makeResult());
    assert.notEqual(next, previous);
  });
});

suite("describe", () => {
  test("every status has a human-readable line", () => {
    // Exhaustive on purpose: the `never` default in the implementation makes a
    // NEW status a compile error, and this asserts none of the existing four
    // fell through to a stringified enum name.
    assert.equal(describeStatus("up"), "responding as expected");
    assert.equal(describeStatus("down"), "not responding");
    assert.equal(describeStatus("degraded"), "responding with an unexpected status");
    assert.equal(describeStatus("unknown"), "not yet checked");
  });

  test("no status renders as its own raw value", () => {
    // A description identical to the status name means somebody added a case
    // that just echoes the input, which reads fine in code review and is
    // useless in a status page.
    for (const status of ["up", "down", "degraded", "unknown"] as const) {
      assert.notEqual(describeStatus(status), status);
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { createLoopPolicy } from "../snippet.js";

const BASE = {
  goal: "scripts/done-means/x.sh exits 0",
  deadline_minutes: 30,
  budget_tokens: 1000,
  max_turns: 3,
  no_progress: { metric: "done-means RED streak", window: 2 },
  on_goal: "commit, PR, harvest",
  on_exhaust: "park — write a decisions-pass item and emit ABANDONED: x.sh",
  priority: ["goal", "deadline", "budget", "max_turns", "no_progress"],
};

function fixedClock(startMs) {
  let t = startMs;
  return { now: () => t, advanceMinutes: (m) => { t += m * 60000; } };
}

test("max_turns trips on the (max+1)th turn", () => {
  const clock = fixedClock(0);
  const lp = createLoopPolicy(BASE, { now: clock.now });
  for (let i = 0; i < BASE.max_turns; i += 1) {
    lp.turn();
    assert.deepEqual(lp.check(), { exhausted: false, guard: null });
  }
  lp.turn(); // the 4th turn, max_turns is 3
  assert.deepEqual(lp.check(), { exhausted: true, guard: "max_turns" });
});

test("no_progress trips after window consecutive reds and resets on false", () => {
  const clock = fixedClock(0);
  const lp = createLoopPolicy(BASE, { now: clock.now });

  lp.noProgress(true);
  assert.equal(lp.check().guard, null, "one red is under the window of 2");

  lp.noProgress(false);
  assert.equal(lp.check().guard, null, "a green resets the streak");

  lp.noProgress(true);
  assert.equal(lp.check().guard, null);
  lp.noProgress(true);
  assert.deepEqual(lp.check(), { exhausted: true, guard: "no_progress" });
});

test("budget trips when spent >= budget_tokens", () => {
  const clock = fixedClock(0);
  let spent = 0;
  const budget = { total: BASE.budget_tokens, spent: () => spent };
  const lp = createLoopPolicy(BASE, { now: clock.now, budget });

  spent = 999;
  assert.equal(lp.check().guard, null, "just under budget");

  spent = 1000;
  assert.deepEqual(lp.check(), { exhausted: true, guard: "budget" });
});

test("budget is skipped when no budget object is injected", () => {
  const clock = fixedClock(0);
  const lp = createLoopPolicy(BASE, { now: clock.now });
  assert.equal(lp.check().guard, null);
});

test("deadline trips via the injected clock", () => {
  const clock = fixedClock(1_700_000_000_000);
  const lp = createLoopPolicy(BASE, { now: clock.now });

  clock.advanceMinutes(29);
  assert.equal(lp.check().guard, null, "29 of 30 minutes");

  clock.advanceMinutes(1);
  assert.deepEqual(lp.check(), { exhausted: true, guard: "deadline" });
});

test("priority order decides when two guards trip simultaneously", () => {
  const clock = fixedClock(0);
  let spent = 0;
  const budget = { total: BASE.budget_tokens, spent: () => spent };
  const lp = createLoopPolicy(BASE, { now: clock.now, budget });

  // Trip budget AND max_turns at once. budget is earlier in priority.
  spent = 5000;
  for (let i = 0; i < BASE.max_turns + 1; i += 1) lp.turn();
  assert.deepEqual(lp.check(), { exhausted: true, guard: "budget" });

  // Same two guards tripped, priority reversed -> max_turns wins.
  const reordered = {
    ...BASE,
    priority: ["goal", "deadline", "max_turns", "budget", "no_progress"],
  };
  const lp2 = createLoopPolicy(reordered, { now: clock.now, budget });
  for (let i = 0; i < BASE.max_turns + 1; i += 1) lp2.turn();
  assert.deepEqual(lp2.check(), { exhausted: true, guard: "max_turns" });
});

test("markGoal reports goal without exhausting the run", () => {
  const clock = fixedClock(0);
  const lp = createLoopPolicy(BASE, { now: clock.now });

  // Even with max_turns blown, a met goal wins: it is first in priority.
  for (let i = 0; i < BASE.max_turns + 1; i += 1) lp.turn();
  assert.equal(lp.check().guard, "max_turns");

  lp.markGoal();
  assert.deepEqual(lp.check(), { exhausted: false, guard: "goal" });
});

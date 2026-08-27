// loop-policy snippet — dependency-free guard evaluation for Workflow scripts.
//
// The Workflow evaluator forbids Date.now, so the clock is INJECTED: pass
// { now } returning epoch milliseconds. Budget is injected the same way.
//
//   const lp = createLoopPolicy(policy, { now: () => clock, budget });
//
// createLoopPolicy(policy, { budget, now })
//   -> { turn(), noProgress(redAgain), markGoal(), check() }
//
// check() -> { exhausted: boolean, guard: string|null }
// Guards are evaluated in policy.priority order; the FIRST hit wins.
// Guard names are the field names: goal, deadline, budget, max_turns,
// no_progress.
//
// `goal` is NOT evaluated here. The done-means check decides the goal, so the
// caller runs it and calls markGoal() when it passes; check() then reports
// { exhausted: false, guard: "goal" }.

function createLoopPolicy(policy, options) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("createLoopPolicy: policy object required");
  }
  const opts = options || {};
  const now = typeof opts.now === "function" ? opts.now : null;
  const budget = opts.budget || null;

  const priority = Array.isArray(policy.priority)
    ? policy.priority.slice()
    : ["goal", "deadline", "budget", "max_turns", "no_progress"];

  const window =
    policy.no_progress && typeof policy.no_progress.window === "number"
      ? policy.no_progress.window
      : null;

  const start = now ? now() : null;

  let turns = 0;
  let redStreak = 0;
  let goalMet = false;

  function turn() {
    turns += 1;
    return turns;
  }

  function noProgress(redAgain) {
    if (redAgain) redStreak += 1;
    else redStreak = 0;
    return redStreak;
  }

  function markGoal() {
    goalMet = true;
  }

  function tripped(guard) {
    if (guard === "goal") return goalMet;

    if (guard === "deadline") {
      if (now === null || start === null) return false;
      if (typeof policy.deadline_minutes !== "number") return false;
      const elapsedMinutes = (now() - start) / 60000;
      return elapsedMinutes >= policy.deadline_minutes;
    }

    if (guard === "budget") {
      if (!budget || typeof budget.spent !== "function") return false;
      if (typeof policy.budget_tokens !== "number") return false;
      return budget.spent() >= policy.budget_tokens;
    }

    if (guard === "max_turns") {
      if (typeof policy.max_turns !== "number") return false;
      return turns > policy.max_turns;
    }

    if (guard === "no_progress") {
      if (window === null) return false;
      return redStreak >= window;
    }

    return false;
  }

  function check() {
    for (let i = 0; i < priority.length; i += 1) {
      const guard = priority[i];
      if (tripped(guard)) {
        // The goal is the one guard that ends the run successfully.
        return { exhausted: guard !== "goal", guard };
      }
    }
    return { exhausted: false, guard: null };
  }

  return { turn, noProgress, markGoal, check };
}

export { createLoopPolicy };

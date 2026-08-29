/**
 * The closed set of roles a raw turn may carry — declared ONCE, read by both
 * the boundary that accepts turns and the observer that judges their absence.
 *
 * WHY THIS FILE EXISTS (#681, cutover blocker B3).
 * `server/capture/liveness-observer.ts` seeded its expected roles as a literal
 * `["user", "assistant"]` written beside — but not derived from — the ingest
 * enum, which accepts three. That literal was CORRECT for the enum it was
 * written next to, and went stale the moment the enum grew. The consequence is
 * not a cosmetic mismatch: a role that is neither seeded nor present in the
 * `GROUP BY` result is never a key in `turnsByRole`, so the silent-role fault
 * is structurally unable to name it. The `tool` role sat frozen at 14,006 rows
 * from 2026-08-01 while `/health` read `stale: false, silent_roles: []` — for
 * eight days, on the very evidence the core01 cutover was to rely on.
 *
 * This is the #447 failure the observer's own docstring cites as its reason to
 * exist, recurring one role wider. Adding `"tool"` to the literal would have
 * fixed the instance and preserved the mechanism, leaving role number four to
 * escape liveness exactly as role number three did. So the set is exported from
 * one place and every consumer derives from it: extending the set extends the
 * seed with no second edit, and there is no second edit to forget.
 *
 * SCOPE — what this does NOT claim. This is the single source for the SERVING
 * tree (`server/`). Two further copies of the same set exist and are pinned by
 * a drift test rather than folded in here:
 *
 *   - `server/capture/ingest-raw-turn.ts` — the legacy tree's own schema. The two
 *     trees are deliberately separate (core01 runs one, the local dogfood
 *     service the other, per `AGENTS.md`), and reaching across to import a
 *     serving-tree module into it would couple them in the direction this repo
 *     has been un-coupling. Pinned by `raw-turn-roles.test.ts`.
 *   - `src/db/migrations/032_raw_turns.sql` — `CHECK (role IN (...))`. Applied
 *     SQL is immutable history; a migration is never edited after it ships, so
 *     the column's constraint can only be pinned, never derived. It is the
 *     ultimate authority — a role this set admits and the column rejects is a
 *     write that fails at the database — which is precisely why a test asserts
 *     they agree rather than trusting that they do.
 *
 * The drift test is the enforcement. Three copies that agree because something
 * CHECKS they agree is a different world from three copies that agree because
 * nobody has changed one yet, and this issue is what the second world costs.
 */

/**
 * Every role the server accepts on a raw turn, in the enum's own order.
 *
 * Consumed by `server/tools/ingest-raw-turn.ts` (as the Zod enum's members) and
 * by `server/capture/liveness-observer.ts` (as the expected-role seed). Those
 * two uses are the point: the boundary that decides what may ARRIVE and the
 * observer that decides what is MISSING must reason over one set, or the
 * observer is blind to whatever the boundary learned to accept most recently.
 */
export const RAW_TURN_ROLES = ["user", "assistant", "tool"] as const;

/** A role the server accepts on a raw turn. */
export type RawTurnRole = (typeof RAW_TURN_ROLES)[number];

/**
 * The roles a healthy LIVE capture lane must be delivering (#685).
 *
 * WHAT MAY ARRIVE AND WHAT MUST BE ARRIVING ARE DIFFERENT QUESTIONS, and
 * answering the second with the first is what broke deploys. `RAW_TURN_ROLES`
 * is the ACCEPT set, and `tool` belongs in it: the bulk importer emits tool
 * turns (`python/openbrain/src/openbrain/apps/bulk/formats.py`) and the
 * column's CHECK constraint admits them. But the live capture parser has
 * exactly two role branches and `else: return None`
 * (`python/openbrain/src/openbrain/apps/capture/records.py`), so no live
 * producer emits `tool` — DELIBERATELY, per
 * `docs/decisions/capture-never-drops-a-turn.md`, which parks the machinery
 * underneath and says in terms: "Do not resolve this by inference, and do not
 * let it be resolved by accident."
 *
 * Seeding liveness from the accept set therefore demanded a role nothing was
 * supposed to send. Measured 2026-08-25: the newest `tool` row was 2026-08-01,
 * 24 days stale with zero recent arrivals, while user and assistant flowed
 * normally — so the observer raised a permanent silent-role fault, `/health`
 * returned 503 (`server/transport/http-app.ts`), and
 * `scripts/local-clone-deploy.sh` rolled back every deploy on `curl -fsS`. A
 * #747 deploy passed its revision proof and ran correctly in production for 80
 * seconds before being reverted by this.
 *
 * It presented as intermittent because the silent-role fault is only evaluated
 * above `MIN_SESSIONS_FOR_SILENCE`, so whether a restart landed green depended
 * on session traffic in the observation window. A deploy gate decided by
 * traffic timing is not a gate.
 *
 * WHY THIS IS NOT A RETURN TO THE #681 LITERAL. #681's lesson is that a role
 * set must be DECLARED ONCE rather than retyped beside an enum, so that a role
 * the boundary learns to accept cannot escape liveness. That lesson is intact:
 * this set is declared here beside the accept set, and `raw-turn-roles.test.ts`
 * pins it as a strict subset — a live role that is not an accepted role is a
 * contradiction and fails the drift test. What changed is not WHERE the set
 * lives but WHICH QUESTION it answers.
 *
 * The third stream — reasoning, tool invocations, tool output — is not dropped.
 * It ships to Langfuse, the home the decision doc names, verified receiving on
 * 2026-08-25. Where it ultimately belongs stays parked; this set takes no
 * position on it.
 */
export const EXPECTED_LIVE_ROLES = ["user", "assistant"] as const;

/** A role the live capture lane is expected to deliver. */
export type ExpectedLiveRole = (typeof EXPECTED_LIVE_ROLES)[number];

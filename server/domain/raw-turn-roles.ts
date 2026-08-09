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
 *   - `src/tools/ingest-raw-turn.ts` — the legacy tree's own schema. The two
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

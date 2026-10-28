/**
 * The closed set of roles a raw turn may carry — declared ONCE, read by both
 * the boundary that accepts turns and the observer that judges their absence.
 *
 * See docs/decisions/raw-turn-roles-declared-once.md for #681, the two pinned
 * copies, and why the drift test is the enforcement.
 */

/**
 * Every role the server accepts on a raw turn, in the enum's own order.
 *
 * Consumed by `server/tools/ingest-raw-turn.ts` (as the Zod enum's members) and
 * by `server/capture/liveness-observer.ts` (as the expected-role seed): the
 * boundary that decides what may ARRIVE and the observer that decides what is
 * MISSING reason over one set.
 *
 * See docs/decisions/raw-turn-roles-declared-once.md.
 */
export const RAW_TURN_ROLES = ["user", "assistant", "tool"] as const;

/** A role the server accepts on a raw turn. */
export type RawTurnRole = (typeof RAW_TURN_ROLES)[number];

/**
 * The roles a healthy LIVE capture lane must be delivering (#685). This is the
 * ACCEPT set narrowed to what live producers actually emit; `raw-turn-roles.test.ts`
 * pins it as a strict subset of `RAW_TURN_ROLES`.
 *
 * See docs/decisions/raw-turn-roles-live-is-not-accept.md.
 */
export const EXPECTED_LIVE_ROLES = ["user", "assistant"] as const;

/** A role the live capture lane is expected to deliver. */
export type ExpectedLiveRole = (typeof EXPECTED_LIVE_ROLES)[number];

/**
 * Roles known NOT to be speech. This is a DENYLIST, deliberately, not an
 * allowlist of speech roles, and it is EXPORTED so the Light sweep
 * (../maintenance/dream-light.ts isCountable) and DISTILL (./distill-window.ts
 * isSpeech) consume this exact set rather than each declaring its own.
 *
 * See docs/decisions/raw-turn-roles-non-speech-is-a-denylist.md.
 */
export const NON_SPEECH_ROLES: ReadonlySet<string> = new Set(["tool", "system"]);

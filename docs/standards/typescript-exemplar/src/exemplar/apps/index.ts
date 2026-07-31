/**
 * The runnable surfaces. Four apps on one shared floor.
 *
 * Each owns its own entry point, its own port (derived from one base in
 * `config.ts`, so they cannot collide), and its own reason to exist as a
 * separate demonstration:
 *
 * - **monitor** -- a TIMED loop. The richest app: retry, scheduling, atomic
 *   state persistence, a read-only HTTP surface. Read this one first.
 * - **watch** -- an EVENT-DRIVEN loop, and the debounce every event-driven loop
 *   eventually needs.
 * - **hook** -- UNTRUSTED INPUT: schema validation, constant-time signature
 *   comparison, a body limit enforced while reading.
 * - **stats** -- a CLI over the history database, and the payoff for having a
 *   database at all.
 *
 * They share `utils/`, `models/`, `db/`, and `config.ts` and know nothing about
 * each other. That is the structural point: four programs, one floor, no
 * cross-app imports.
 */

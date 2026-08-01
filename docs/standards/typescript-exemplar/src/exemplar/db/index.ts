/**
 * Database layer -- typed SQL over `node:sqlite`, for HISTORY.
 *
 * WHY A DATABASE WHEN THE MONITOR ALREADY HAS A JSON STORE
 *
 * Both exist on purpose, and knowing which to reach for is the lesson:
 *
 * - `apps/monitor/store.ts` holds CURRENT state: one record per target,
 *   rewritten every round, read whole. A JSON file is genuinely right --
 *   bounded size, single writer, human-readable during an incident, no
 *   operational dependency.
 * - This layer holds HISTORY: every observation ever made, appended forever,
 *   queried by time range and aggregated. A JSON file is the wrong tool the
 *   moment you want "p95 latency for this target over the last day", because
 *   answering it means loading and scanning everything.
 *
 * The rule is not "always use a database". It is: match the store to the access
 * pattern. A JSON file that must be scanned to answer a question is a database
 * with none of the features.
 *
 * WHY `node:sqlite` AND NOT AN ORM
 *
 * `node:sqlite` is in the standard library as of Node 22 -- no dependency, no
 * native build step. `better-sqlite3` was the first choice here and was dropped
 * after its install failed to compile under node-gyp on this machine: a
 * reference repo that cannot `npm install` on a clean clone teaches nothing.
 *
 * No ORM because the query surface is four statements. An ORM earns its cost
 * when the schema is broad and the queries are generated; here it would add a
 * dependency and a layer of indirection over SQL that fits on one screen.
 *
 * The SQL is written as PREPARED STATEMENTS WITH BOUND PARAMETERS, never string
 * concatenation. That is not stylistic -- concatenating a WHERE clause is how
 * injection happens, and it is the exact hand-rolling the standard warns about.
 */

export { Database } from "./database.ts";
export type { CheckRecord, TargetSummary } from "./database.ts";

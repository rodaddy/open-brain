/**
 * Ad-hoc SQL against the configured database. `bun run db "<sql>"`.
 *
 * WHY THIS EXISTS. There was no way to run a one-off query, so every ad-hoc
 * look at live state meant re-deriving the connection from .env at the shell.
 * That went wrong repeatedly and in the same way: this repo has no
 * DATABASE_URL. It has five separate DB_* variables (src/db/pool.ts:12-24), so
 * the reflexive `psql "$DATABASE_URL"` connects to a *default local* database
 * named after the OS user, which either fails or -- worse -- succeeds against
 * something that is not Open Brain.
 *
 * The operator's instruction, 2026-07-28, after watching it happen five times:
 * "Why isn't this already preset up for all the database stuff so that when
 * we're running this local dogfooding, it always just works? ... it should be
 * zero times."
 *
 * WHY IT GOES THROUGH createPool RATHER THAN SHELLING OUT TO psql. A psql
 * wrapper would be a SECOND definition of where the data lives, and the two
 * would drift. It also silently defeats local-clone mode: src/local-clone-mode.ts
 * fails closed on DB_NAME/DB_USER/loopback when OPENBRAIN_LOCAL_CLONE=1, and a
 * hand-built psql line inherits none of that -- so a query meant for the clone
 * would read production. Reusing createPool means this tool is pointed wherever
 * the app is pointed, including the clone, with no second source of truth.
 *
 * READ-ONLY BY DEFAULT, and that is deliberate rather than incidental. This is
 * the tool reached for while thinking, on a live corpus the operator is actively
 * grading -- exactly the context in which a careless UPDATE is unrecoverable.
 * Mutations require --write, which is a typed acknowledgement, not a safety net.
 */

import { createPool } from "../src/db/pool.ts";

// NOISE, KNOWN AND LEFT ALONE: every run prints a pg DeprecationWarning stack
// about querying a client that is "already executing a query". It comes from
// src/db/pool.ts's on("connect") session setup, not from anything here, and the
// query results are unaffected. Bun raises it below console.warn, so the
// obvious interception does NOT work -- tried and removed rather than left in
// as decoration. Fixing it means changing the pool's connect handshake, which
// is on every server path; that is not a change worth making to tidy a CLI's
// output, so the warning stays until the pool is touched for its own reasons.

const MUTATING =
  /^\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i;

function usage(): never {
  console.error(
    [
      'Usage: bun run db "<sql>" [--write] [--json]',
      "",
      "  --write   allow a mutating statement (refused otherwise)",
      "  --json    emit rows as JSON instead of a table",
      "",
      "Examples:",
      '  bun run db "select count(*) from candidate_memory"',
      '  bun run db "select action, count(*) from candidate_grade',
      '              where superseded_at is null group by 1"',
    ].join("\n"),
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const json = argv.includes("--json");
const sql = argv
  .filter((a) => !a.startsWith("--"))
  .join(" ")
  .trim();

if (!sql) usage();

// Refuse mutations unless asked. Checked on the raw text rather than after
// parsing: this is a guard against reflex, not against a determined caller, and
// a partial SQL parser would be more confident and less correct.
if (MUTATING.test(sql) && !write) {
  console.error(
    "Refused: that statement mutates. Re-run with --write if you mean it.",
  );
  process.exit(1);
}

const pool = createPool();
try {
  const result = await pool.query(sql);
  if (json) {
    console.log(JSON.stringify(result.rows, null, 2));
  } else if (result.rows.length === 0) {
    // rowCount, not rows.length: an UPDATE reports what it touched and returns
    // no rows, and "0 rows" would read as "nothing happened".
    console.log(`(no rows) rowCount=${result.rowCount ?? 0}`);
  } else {
    console.table(result.rows);
    console.log(
      `(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`,
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await pool.end();
}

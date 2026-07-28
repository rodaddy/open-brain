/**
 * Build the 50-item grading pilot set. `bun run sample:grade`.
 *
 * WHY A PILOT INSTEAD OF THE WHOLE QUEUE. The operator, 2026-07-28, after a
 * 41-agent run measured rules against all 1,414 candidates and found the whole
 * approach unworkable: "maybe instead of doing full runs against everything,
 * you get a subset of 50 that have good interactions and run your tests based
 * on that, and then when that's good, run it against the rest. Really no reason
 * to run against everything when you don't even know what you're doing works."
 *
 * WHAT QUALIFIES, and why each condition is here rather than tuned later:
 *
 *   unit_kind='exchange'    The 1,104 'fragment' rows come from the per-turn
 *                           extractor that 041 replaced. They cannot show "what
 *                           I said and what was responded" because they are cut
 *                           mid-conversation, so grading them trains the system
 *                           on a dead code path.
 *   anchor_kind != 'orphan' An orphan has no operator turn at all. The unit the
 *                           operator grades is the INTERACTION; with no ask
 *                           there is nothing to judge the response against.
 *   >= 2 agent turns        One-line acknowledgements have no response to grade.
 *                           This is NOT a length floor on the operator's words
 *                           -- those are untouched, and a 3-character operator
 *                           turn qualifies if the agent actually did something.
 *   operator_len >= 40      Applies to the OPERATOR SEGMENT only, and only for
 *                           the pilot. A short turn can carry the whole signal
 *                           ("me saying okay is the equivalent of doubt"), so
 *                           this must never migrate into the extractor or the
 *                           real queue. It is here because a pilot needs items
 *                           with enough context to judge the rendering by.
 *   length < 3990           52 of 310 exchanges sit at the 4,000-char cap and
 *                           are cut mid-content. Grading a truncated exchange
 *                           judges an artifact of the cap, not the interaction.
 *
 * ALL SIX AskUserQuestion EXCHANGES ARE INCLUDED UNCONDITIONALLY, including the
 * three that fail the filters above. There are only 6 in the entire corpus, so
 * random sampling would likely surface none -- and AUQ is the shape most likely
 * to render wrong, since the operator's decision arrives as a tool_result and
 * had to be reconstructed. A pilot exists to catch exactly that, so the
 * malformed ones are the point rather than an embarrassment to filter out.
 * Operator, verbatim: "make sure to add at least a couple of ask user question
 * things and make sure that those are based as user questions."
 *
 * DETERMINISTIC by md5(id) rather than random(): re-running must produce the
 * same 50, or "we fixed the rendering" cannot be checked against the same set.
 */

import { createPool } from "../src/db/pool.ts";

const TARGET = 50;

const pool = createPool();

try {
  // Every AUQ exchange, filters bypassed. See the header.
  const auq = await pool.query(
    `SELECT id, anchor_kind, length(content) AS len
       FROM candidate_memory
      WHERE unit_kind = 'exchange' AND anchor_kind = 'askuserquestion'
      ORDER BY md5(id::text)`,
  );

  // Typed exchanges with real back-and-forth. The agent-turn count is a marker
  // count on the rendered content: distill-exchange writes each body turn as a
  // line beginning "agent:" or "tool:".
  const typed = await pool.query(
    `WITH scored AS (
       SELECT id, anchor_kind, length(content) AS len,
              (length(content) - length(replace(content, 'agent:', ''))) / 6 AS agent_turns,
              length(split_part(content, E'\n\nagent:', 1)) AS operator_len
         FROM candidate_memory
        WHERE unit_kind = 'exchange' AND anchor_kind = 'typed'
     )
     SELECT id, anchor_kind, len
       FROM scored
      WHERE agent_turns >= 2 AND operator_len >= 40 AND len < 3990
      ORDER BY md5(id::text)
      LIMIT $1`,
    [TARGET - auq.rowCount!],
  );

  const picked = [...auq.rows, ...typed.rows];

  console.log(`pilot set: ${picked.length} exchanges`);
  console.log(
    `  askuserquestion: ${auq.rowCount} (all of them, filters bypassed)`,
  );
  console.log(`  typed:           ${typed.rowCount}`);
  console.log();
  console.log("ids:");
  for (const r of picked) {
    console.log(`  ${r.id}  ${r.anchor_kind.padEnd(15)} ${r.len} chars`);
  }
} finally {
  await pool.end();
}

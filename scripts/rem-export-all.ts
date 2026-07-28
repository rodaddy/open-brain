/**
 * Export every exchange candidate for a full REM pass.
 *
 * WHY NOT THE 50-ITEM SAMPLE. scripts/bakeoff-export.ts selects by
 * md5(id::text) -- a scattered random sample, deliberately NOT each other's
 * neighbours. That was right for comparing prompts on isolated items and is
 * wrong for anything REM actually does: you cannot test grouping, merging, or
 * contradiction pairing on a set chosen to have no groups in it.
 *
 * Measured 2026-07-28: 310 exchanges, 586,251 chars (~147k tokens). The whole
 * population fits in one call on terra low, so there is no reason to sample.
 *
 * CORROBORATION COMES ALONG. Light already maintains occurrence and session
 * counts (src/dream-light.ts:26-30), and dream-design.md:806-816 says confidence
 * must come from that evidence rather than a model's self-report. Every bake-off
 * run so far withheld it -- the model was asked how sure it was, with the actual
 * evidence of importance left out of the prompt. This export carries it.
 *
 * session_count and occurrence_count are NOT the same signal and are never
 * summed: "said ten times in one chatty session" is one voice repeating itself;
 * "said in six distinct sessions" is corroboration.
 *
 * FRAGMENTS ARE EXCLUDED. The 1,104 fragment rows come from the replaced
 * extractor. Grading them would measure a pipeline that no longer runs.
 */

import { createPool } from "../src/db/pool.ts";

const OUT = "/Volumes/collab/rem-all-exchanges.json";

const pool = createPool();
try {
  // LEFT JOIN, not INNER: a candidate with no occurrence row has been said
  // once, which is a real and common case. An inner join would silently drop
  // exactly the one-off decisions dream-design.md:814-816 flags as the known
  // hole in corroboration-based promotion.
  const { rows } = await pool.query(
    `SELECT c.id::text                     AS id,
            c.anchor_kind,
            c.candidate_type,
            c.authority_tier,
            c.uncertain,
            c.uncertainty_reason,
            c.first_said_at,
            c.last_said_at,
            c.operator_text,
            c.content,
            length(c.content)              AS content_len,
            COALESCE(o.occurrence_count, 1) AS occurrence_count,
            COALESCE(o.session_count, 1)    AS session_count
       FROM candidate_memory c
       LEFT JOIN content_occurrences o ON o.content_hash = c.content_hash
      WHERE c.unit_kind = 'exchange'
      ORDER BY c.first_said_at NULLS LAST, c.id`,
  );

  await Bun.write(OUT, JSON.stringify(rows, null, 2));

  const chars = rows.reduce((n, r) => n + (r.content_len ?? 0), 0);
  const truncated = rows.filter((r) => (r.content_len ?? 0) >= 3990).length;
  const byKind: Record<string, number> = {};
  for (const r of rows)
    byKind[r.anchor_kind ?? "null"] =
      (byKind[r.anchor_kind ?? "null"] ?? 0) + 1;
  const corroborated = rows.filter((r) => Number(r.session_count) > 1).length;

  console.log(`wrote ${rows.length} exchanges to ${OUT}`);
  console.log(
    `  ${chars.toLocaleString()} chars (~${Math.round(chars / 4000)}k tokens)`,
  );
  console.log(
    `  by anchor_kind: ${Object.entries(byKind)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  console.log(`  corroborated (session_count > 1): ${corroborated}`);
  console.log(
    `  at/near the 4000-char cap: ${truncated}  <-- truncated at source`,
  );
} finally {
  await pool.end();
}

/**
 * Export the 50-item pilot set as JSON for the REM grading bake-off.
 *
 * Same selection as scripts/grading-sample.ts -- see that file's header for why
 * each filter is there and why all six AskUserQuestion exchanges bypass them.
 * This one writes content, not just ids, because the bake-off runs outside the
 * repo (the MLX venv at /Volumes/ThunderBolt/open-brain-local) and cannot reach
 * the pool.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pool.ts";

// NEVER /Volumes/collab. That is the SHARED volume: its README documents a
// 3-folder-per-agent structure, and root-level scratch is not part of it. This
// line wrote `/Volumes/collab/rem-bakeoff-items.json` and was one of 37 files
// this repo left in that root -- which the operator, in a sandboxed session,
// could not even `ls` to find out what was going on. Nothing here runs remotely;
// there was never a reason to use the share. Local work, repo-local output.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repoRoot, "out");
const OUT = join(outDir, "rem-bakeoff-items.json");
const TARGET = 50;

mkdirSync(outDir, { recursive: true });

const pool = createPool();
try {
  const auq = await pool.query(
    `SELECT id::text AS id, anchor_kind, content
       FROM candidate_memory
      WHERE unit_kind = 'exchange' AND anchor_kind = 'askuserquestion'
      ORDER BY md5(id::text)`,
  );

  const typed = await pool.query(
    `WITH scored AS (
       SELECT id, anchor_kind, content, length(content) AS len,
              (length(content) - length(replace(content, 'agent:', ''))) / 6 AS agent_turns,
              length(split_part(content, E'\n\nagent:', 1)) AS operator_len
         FROM candidate_memory
        WHERE unit_kind = 'exchange' AND anchor_kind = 'typed'
     )
     SELECT id::text AS id, anchor_kind, content
       FROM scored
      WHERE agent_turns >= 2 AND operator_len >= 40 AND len < 3990
      ORDER BY md5(id::text)
      LIMIT $1`,
    [TARGET - auq.rowCount!],
  );

  const rows = [...auq.rows, ...typed.rows];
  await Bun.write(OUT, JSON.stringify(rows, null, 2));
  console.log(
    `wrote ${rows.length} items to ${OUT} (${auq.rowCount} auq, ${typed.rowCount} typed)`,
  );
} finally {
  await pool.end();
}

import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Pool } from "pg";
import { FROZEN_COHORT_SIZE, freezeCohort } from "./rem-ethereal-cohort.ts";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("freezes public input when search_path contains shadow source tables", async () => {
  const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 1 });
  const namespace = `ethereal-public-source-${process.pid}`;
  const shadowSchema = `ethereal_shadow_${process.pid}`;
  const publicIds = Array.from({ length: FROZEN_COHORT_SIZE }, () => randomUUID());
  const shadowIds = Array.from({ length: FROZEN_COHORT_SIZE }, () => randomUUID());
  let frozenSchema = "";

  try {
    await pool.query(`CREATE SCHEMA ${shadowSchema}`);
    await pool.query(
      `CREATE TABLE ${shadowSchema}.candidate_memory
         (LIKE public.candidate_memory INCLUDING ALL)`,
    );
    await pool.query(
      `CREATE TABLE ${shadowSchema}.content_occurrences
         (LIKE public.content_occurrences INCLUDING ALL)`,
    );
    await pool.query(
      `CREATE TABLE ${shadowSchema}.candidate_reinforcement
         (LIKE public.candidate_reinforcement INCLUDING ALL)`,
    );

    for (const [source, ids] of [
      ["public", publicIds],
      [shadowSchema, shadowIds],
    ] as const) {
      for (const [index, id] of ids.entries()) {
        const content = `${source} frozen content ${index}`;
        await pool.query(
          `INSERT INTO ${source}.candidate_memory
             (id, namespace, candidate_type, content, content_hash,
              source_turn_ids, model, unit_kind, uncertain)
           VALUES ($1,$2,'fact',$3,$4,$5::uuid[],'fixture-model','exchange',false)`,
          [id, namespace, content, hash(content), [randomUUID()]],
        );
      }
    }

    await pool.query(`SET search_path TO ${shadowSchema}, public`);
    const frozen = await freezeCohort(pool, namespace);
    frozenSchema = frozen.schema;

    expect(frozen.candidates.map((candidate) => candidate.id).sort()).toEqual(
      [...publicIds].sort(),
    );
    expect(
      frozen.candidates.every((candidate) => candidate.content.startsWith("public ")),
    ).toBe(true);
  } finally {
    await pool.query("SET search_path TO public");
    if (frozenSchema) await pool.query(`DROP SCHEMA ${frozenSchema} CASCADE`);
    await pool.query(`DROP SCHEMA ${shadowSchema} CASCADE`);
    await pool.query("DELETE FROM public.candidate_memory WHERE namespace = $1", [
      namespace,
    ]);
    await pool.end();
  }
});

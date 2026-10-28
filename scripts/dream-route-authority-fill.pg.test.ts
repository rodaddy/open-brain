/**
 * The `authority_tier` fill, against a real Postgres.
 *
 * Plants the three populations the rule has to tell apart -- an
 * operator-anchored exchange, a non-operator row, and a row whose tier was
 * already set -- and asserts the fill writes `decided`, writes `observed`,
 * leaves the third alone, and does nothing at all on a second run.
 *
 * `anchor_turn_id` stays NULL throughout, so no `ob_raw_turns` rows are
 * needed: it is the only column referencing that table (041:77), and 041:110
 * permits `unit_kind = 'fragment'` only with a NULL anchor.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { fillAuthorityTiers } from "./dream-route-authority-fill.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `authority-fill-${process.pid}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const typedExchange = randomUUID();
const auqExchange = randomUUID();
const orphanExchange = randomUUID();
const fragment = randomUUID();
const preSet = randomUUID();

async function insertCandidate(row: {
  id: string;
  unitKind: "exchange" | "fragment";
  anchorKind: string | null;
  authorityTier: string | null;
}): Promise<void> {
  const content = `authority fill ${row.id}`;
  await pool.query(
    `INSERT INTO candidate_memory
       (id, namespace, candidate_type, content, content_hash, source_turn_ids,
        model, unit_kind, anchor_kind, operator_text, authority_tier)
     VALUES ($1,$2,'fact',$3,$4,$5::uuid[],'fixture-model',$6,$7,'operator said it',$8)`,
    [
      row.id,
      namespace,
      content,
      hash(content),
      [randomUUID()],
      row.unitKind,
      row.anchorKind,
      row.authorityTier,
    ],
  );
}

async function tierOf(id: string): Promise<string | null> {
  const result = await pool.query<{ authority_tier: string | null }>(
    "SELECT authority_tier FROM candidate_memory WHERE id = $1",
    [id],
  );
  return result.rows[0]?.authority_tier ?? null;
}

beforeAll(async () => {
  await insertCandidate({
    id: typedExchange,
    unitKind: "exchange",
    anchorKind: "typed",
    authorityTier: null,
  });
  await insertCandidate({
    id: auqExchange,
    unitKind: "exchange",
    anchorKind: "askuserquestion",
    authorityTier: null,
  });
  await insertCandidate({
    id: orphanExchange,
    unitKind: "exchange",
    anchorKind: "orphan",
    authorityTier: null,
  });
  await insertCandidate({
    id: fragment,
    unitKind: "fragment",
    anchorKind: null,
    authorityTier: null,
  });
  await insertCandidate({
    id: preSet,
    unitKind: "exchange",
    anchorKind: "typed",
    authorityTier: "canon",
  });
});

afterAll(async () => {
  await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [namespace]);
  await pool.end();
});

describe("fillAuthorityTiers (live Postgres)", () => {
  test("tiers operator-anchored exchanges decided and everything else observed", async () => {
    const counts = await fillAuthorityTiers(pool, { namespace });

    expect(counts).toEqual({ decided: 2, observed: 2, alreadySet: 1 });
    expect(await tierOf(typedExchange)).toBe("decided");
    expect(await tierOf(auqExchange)).toBe("decided");
    expect(await tierOf(orphanExchange)).toBe("observed");
    expect(await tierOf(fragment)).toBe("observed");
  });

  test("leaves a row that already carried a tier untouched", async () => {
    expect(await tierOf(preSet)).toBe("canon");
  });

  test("changes nothing on a second run", async () => {
    const counts = await fillAuthorityTiers(pool, { namespace });

    expect(counts).toEqual({ decided: 0, observed: 0, alreadySet: 5 });
    expect(await tierOf(typedExchange)).toBe("decided");
    expect(await tierOf(preSet)).toBe("canon");
  });
});

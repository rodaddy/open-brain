/**
 * Live-Postgres tests for the sessions collision evidence script (issue 1612).
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL` and fails hard without it. Run with
 * `npm run test:isolated -- scripts/sessions-collision-evidence.pg.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { getEmbeddingTarget } from "../server/embedding/embedding-targets.ts";
import type { JevConfig, JevFetch } from "../server/integrations/jev.ts";
import { collectEvidence, findPairs, toTsv } from "./sessions-collision-evidence.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const NAMESPACE = `collision-evidence-pg-${process.pid}`;
const PROJECT = "p1612";

const config: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://jev.test/v1",
  model: "jev-test",
  timeoutMs: 1_000,
  maxRequestBytes: 192_000,
  maxStateQuestionBytes: 96_000,
};

async function insertSession(
  summary: string,
  contentHash: string | null,
  embedded: boolean,
): Promise<string> {
  const embedding = embedded
    ? `[${Array.from({ length: 768 }, () => 0.02).join(",")}]`
    : null;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (summary, project, created_by, namespace, content_hash, embedding)
     VALUES ($1, $2, 'test', $3, $4, $5::halfvec)
     RETURNING id::text AS id`,
    [summary, PROJECT, NAMESPACE, contentHash, embedding],
  );
  const [row] = rows;
  if (!row) throw new Error("session insert returned no row");
  return row.id;
}

const byFirst = (x: string[], y: string[]): number =>
  (x[0] ?? "").localeCompare(y[0] ?? "");

const target = getEmbeddingTarget("sessions");
const hashOf = (summary: string): string =>
  target.sourceHash({ summary, project: PROJECT });

let holderA = "";
let dupA = "";
let holderB = "";
let dupB = "";

beforeAll(async () => {
  holderA = await insertSession("collides a", hashOf("collides a"), true);
  dupA = await insertSession("collides a", null, false);
  holderB = await insertSession("collides b", hashOf("collides b"), true);
  dupB = await insertSession("collides b", null, false);
  await insertSession("no collision", null, false);
});

afterAll(async () => {
  await pool.query("DELETE FROM sessions WHERE namespace = $1", [NAMESPACE]);
  await pool.end();
});

/** A fake Jev endpoint: noul by dup id, or a 400 for refused dup ids. */
function fakeFetch(nouls: Map<string, number>, refused: Set<string>): JevFetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      state: { records: { key: string }[] };
      questions: Record<string, unknown>;
    };
    const key = body.state.records[0]?.key ?? "";
    if (refused.has(key)) return new Response("refused", { status: 400 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = { type: "noul", noul: nouls.get(key) ?? 0 };
    }
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as JevFetch;
}

describe("sessions collision evidence (live Postgres)", () => {
  test("finds exactly the pairs whose fresh hash another row stores", async () => {
    const { scanned, pairs } = await findPairs(pool, 100, [NAMESPACE]);
    expect(scanned).toBe(3);
    const found = pairs.map((p) => [p.dupId, p.holderId]).sort(byFirst);
    expect(found).toEqual(
      [
        [dupA, holderA],
        [dupB, holderB],
      ].sort(byFirst),
    );
  });

  test("a dry run makes zero fetch calls and reports the Jev-call count", async () => {
    const throwing = (() => {
      throw new Error("dry run must not call fetch");
    }) as unknown as JevFetch;
    const lines: string[] = [];
    const summary = await collectEvidence(pool, {
      sample: 100,
      yes: false,
      namespaces: [NAMESPACE],
      config,
      fetchFn: throwing,
      log: (line) => lines.push(line),
    });
    expect(summary.pairs).toBe(2);
    expect(summary.wouldCallJev).toBe(2);
    expect(summary.jevErrors).toBe(0);
    expect(lines.join("\n")).toContain("would_call_jev=2");
  });

  test("--yes writes the nouls into the TSV and summary", async () => {
    const lines: string[] = [];
    const summary = await collectEvidence(pool, {
      sample: 100,
      yes: true,
      namespaces: [NAMESPACE],
      config,
      fetchFn: fakeFetch(
        new Map([
          [dupA, 0.95],
          [dupB, 0.15],
        ]),
        new Set(),
      ),
      log: (line) => lines.push(line),
    });
    expect(summary.identicalText).toBe(2);
    expect(summary.jevErrors).toBe(0);
    expect(summary.buckets[9]).toBe(1);
    expect(summary.buckets[1]).toBe(1);
    const rows = toTsv(summary.results).replace(/\n$/, "").split("\n");
    expect(rows[0]).toBe(
      "dup_id\tholder_id\tdup_len\tholder_len\tidentical_text\tjev_noul\tjev_error",
    );
    const byDup = new Map(rows.slice(1).map((r) => [r.split("\t")[0], r.split("\t")]));
    expect(byDup.get(dupA)?.slice(1)).toEqual([
      holderA,
      expect.any(String),
      expect.any(String),
      "true",
      "0.95",
      "",
    ]);
    expect(byDup.get(dupB)?.[5]).toBe("0.15");
    expect(lines.join("\n")).toContain("0.9-1.0=1");
    expect(lines.join("\n")).not.toContain("collides");
  });

  test("a refused pair records jev_error and the other pair completes", async () => {
    const summary = await collectEvidence(pool, {
      sample: 100,
      yes: true,
      namespaces: [NAMESPACE],
      config,
      fetchFn: fakeFetch(new Map([[dupB, 0.7]]), new Set([dupA])),
      log: () => {},
    });
    const a = summary.results.find((r) => r.dupId === dupA);
    const b = summary.results.find((r) => r.dupId === dupB);
    expect(a?.jevError).toContain("status 400");
    expect(a?.jevNoul).toBeNull();
    expect(b?.jevNoul).toBe(0.7);
    expect(b?.jevError).toBe("");
    expect(summary.jevErrors).toBe(1);
  });
});

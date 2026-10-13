/**
 * Golden byte-parity for the REST search response across the cut-2 repoint
 * (issue 841, clause `rest-search-response-unchanged`).
 *
 * WHAT THIS PROTECTS AND WHY IT IS A GOLDEN FILE. Cut 2 swaps the implementation
 * under `GET /api/v1/search`: the route used to call the legacy fallback
 * executors, and now calls the modern engine's. Import-shape clauses prove the
 * CALL moved; only the wire body proves the ANSWER did not. The ported
 * differences that could change a caller's bytes -- D1 (scoped fallback), D3
 * (`explicit_links` carried, not dropped) and D5 -- are all response-visible, so
 * a serialized snapshot captured against `origin/main` and compared here is the
 * one artifact that catches any of them ported wrong.
 *
 * The fixture is captured from the OLD tree, not this one. `GOLDEN_WRITE=1`
 * makes this file write `__fixtures__/rest-search-golden.json` instead of
 * comparing; that mode is run once, at `origin/main`, and the resulting bytes
 * are committed. Running it here without the variable is the assertion. A
 * mismatch is a FINDING, never a prompt to refresh the fixture: adjusting either
 * side to agree would delete exactly the signal the clause exists to raise.
 *
 * DETERMINISM. Everything the response can show is pinned: fixed UUIDs, fixed
 * `created_at`/`updated_at`, fixed `usefulness_score`, fixed tags, and a
 * constant stub embedding for both the stored rows and the query, so the vector
 * arm's distances are a function of the fixture alone. No clock, no random id
 * and no live embedding provider participates. The rows carry a nonsense token
 * (`zqxparity`) so the lexical arm matches these rows and nothing else that may
 * exist in the database.
 *
 * BOTH ARMS ARE EXERCISED, AND THEY NEED DIFFERENT IDENTITIES. The route
 * branches on whether the resolved namespace filter is the shared one: shared
 * goes to `executeSearchWithSharedFallback` (positional,
 * `requestedShared = true`), anything else to
 * `executeSearchWithScopedSharedFallback` (request object). A repoint that got
 * one calling convention right and the other wrong is exactly the failure mode,
 * so both are in the golden file.
 *
 * The scoped arm is driven by a SCOPED token, not the admin one. An admin is a
 * global reader, so `readableNamespaces` returns `undefined` and
 * `canReadNamespace` would still allow the request -- but the first capture
 * against `origin/main` came back `403 Permission denied` for
 * `admin` + `namespace=parity-scoped`, because a global reader's allowed set does
 * not contain a namespace nobody granted it. A scoped `agent` identity whose
 * `clientId` IS the namespace reads `[clientId, shared-kb]`
 * (`server/domain/read-scope.ts`), which both passes the gate and makes
 * `namespaceFilterFor` return a plain non-shared string -- the one input shape
 * that reaches the scoped executor.
 *
 * The handler is driven directly rather than over HTTP: `supertest` is not a
 * dependency here, and `getSearch(deps, req, res)` is the same function
 * `createRestRouter` binds -- driving it takes the express plumbing out of the
 * comparison without taking any of the route's own logic out.
 *
 * DATABASE. Requires `OPENBRAIN_TEST_DATABASE_URL`; run through
 * `bun run test:isolated`.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import type { Request, Response } from "express";
import {
  goldenWriteMode,
  requireTestDatabaseUrl,
} from "../../scripts/test-support/require-test-database.ts";
import { getSearch } from "./rest-api-reads.ts";
import type { RestDeps } from "./rest-api-helpers.ts";
import { silentLogger } from "./testing/silent-logger.ts";
import { sharedNamespaceConfig } from "../security/shared-namespace-ambient.ts";
import type { AuthInfo } from "../types.ts";

const DB_URL = requireTestDatabaseUrl();

const GOLDEN_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "__fixtures__",
  "rest-search-golden.json",
);

/** Set to write the fixture from the pre-repoint tree instead of comparing. */
const WRITE_MODE = goldenWriteMode();

/** The shared partition's canonical name; `server/security/shared-namespace.ts`. */
const SHARED = "shared-kb";
/** A scoped namespace, fixed so the fixture's `namespace` field is stable. */
const SCOPED = "parity-scoped";

/** A rare token, so the lexical arm cannot match rows this test did not seed. */
const TOKEN = "zqxparity";

/**
 * One constant 768-dim unit vector, used for BOTH the stored embeddings and the
 * query embedding. Identical vectors give a cosine distance of 0 on every row,
 * so the vector arm's ordering is decided by the remaining ranking terms rather
 * than by float noise -- which is what makes the bytes reproducible.
 */
const VECTOR: number[] = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const VECTOR_LITERAL = `[${VECTOR.join(",")}]`;

const CREATED_AT = "2026-01-02T03:04:05.000Z";

interface SeedRow {
  id: string;
  namespace: string;
  content: string;
  usefulness: number;
}

/**
 * TOTAL ORDER, NOT JUST A SEEDED CORPUS (issue 1241).
 *
 * The final row order is `fusedScore` descending (`search-engine.ts:406`), fed
 * by RECIPROCAL RANK -- the POSITION each row took in each arm -- so a tie
 * inside either arm makes the fused order depend on whatever order Postgres
 * happened to return. Both arms tied on the original corpus:
 *
 *   - vector arm (`search-engine.ts:272-274`) orders by
 *     `distance*W + (1 - usefulness)*W + age*W`. Every row carries the SAME
 *     constant embedding (distance 0), the SAME `created_at`, and originally the
 *     SAME `usefulness_score` of 5 -- so the whole expression was constant.
 *   - lexical arm (`search-engine.ts:322`) orders by
 *     `ts_rank_cd(...) DESC` (`search-engine-sql.ts:272`). Every row originally
 *     carried the token exactly once in an equal-length body, so every
 *     `ts_rank_cd` was equal too.
 *
 * With no tiebreaker column in either `ORDER BY`, `scoped gamma` and
 * `scoped delta` swapped between runs on one unchanged SHA (run 458 pass, 459
 * fail). The fix is in the CORPUS, not the assertion: each row now carries a
 * DISTINCT `usefulness_score` and a DISTINCT number of token occurrences, so
 * the vector expression and `ts_rank_cd` are both strictly monotone across the
 * four rows and each arm has exactly one legal order. `usefulness` is
 * response-visible, and these are fixed integers, so the bytes stay pinned.
 *
 * Four rows over two namespaces including the shared one, so the shared arm has
 * something to fan out to and the scoped arm has something to top up from.
 */
const SEED: SeedRow[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    namespace: SHARED,
    content: `${TOKEN} ${TOKEN} ${TOKEN} ${TOKEN} shared alpha`,
    usefulness: 8,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    namespace: SHARED,
    content: `${TOKEN} ${TOKEN} ${TOKEN} shared beta`,
    usefulness: 6,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    namespace: SCOPED,
    content: `${TOKEN} ${TOKEN} scoped gamma`,
    usefulness: 4,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    namespace: SCOPED,
    content: `${TOKEN} scoped delta`,
    usefulness: 2,
  },
];

const pool = new Pool({ connectionString: DB_URL });

/** Global reader; takes the shared arm when it asks for `shared-kb` by name. */
const ADMIN_AUTH: AuthInfo = { role: "admin", clientId: "rest-search-parity" };
/**
 * Scoped reader whose `clientId` is the scoped namespace, so its readable set is
 * `[SCOPED, shared-kb]` -- the identity shape that reaches the scoped executor.
 */
const SCOPED_AUTH: AuthInfo = { role: "agent", clientId: SCOPED };

function fakeRequest(query: Record<string, string>, auth: AuthInfo): Request {
  return { query, params: {}, auth } as unknown as Request;
}

interface Captured {
  status: number;
  body: unknown;
}

function fakeResponse(captured: Captured): Response {
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return res as unknown as Response;
}

async function callSearch(
  deps: RestDeps,
  query: Record<string, string>,
  auth: AuthInfo,
): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined };
  await getSearch(deps, fakeRequest(query, auth), fakeResponse(captured));
  return captured;
}

async function seed(): Promise<void> {
  await pool.query("DELETE FROM thoughts WHERE id = ANY($1::uuid[])", [
    SEED.map((row) => row.id),
  ]);
  for (const row of SEED) {
    await pool.query(
      `INSERT INTO thoughts
         (id, content, tags, source, created_by, created_at, updated_at,
          namespace, tier, usefulness_score, access_count, embedding)
       VALUES ($1, $2, $3::text[], 'parity-fixture', 'parity', $4, $4,
               $5, 'warm', $7, 0, $6::halfvec)`,
      [
        row.id,
        row.content,
        [TOKEN],
        CREATED_AT,
        row.namespace,
        VECTOR_LITERAL,
        row.usefulness,
      ],
    );
  }
}

async function unseed(): Promise<void> {
  await pool.query("DELETE FROM thoughts WHERE id = ANY($1::uuid[])", [
    SEED.map((row) => row.id),
  ]);
}

describe("REST search response is byte-identical across the cut-2 repoint", () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    await unseed();
    await pool.end();
  });

  test("both fallback arms serialize to the committed golden bytes", async () => {
    const deps: RestDeps = {
      pool,
      // A stub, so no embedding provider participates and the query vector is
      // the same constant the rows carry.
      embedFn: (async () => VECTOR) as unknown as RestDeps["embedFn"],
      logger: silentLogger(),
      searchEmbeddingTimeoutMs: 3000,
      // The golden bytes were captured at `origin/main`, where the engine read
      // these names ambiently from the environment. Reading them through the
      // same bridge here reproduces that resolution exactly rather than
      // inventing a set: a hand-written literal that disagreed with the
      // environment would move the bytes and be indistinguishable from a
      // genuine repoint defect.
      sharedNamespaceNames: sharedNamespaceConfig(),
    };

    const shared = await callSearch(
      deps,
      { q: TOKEN, namespace: SHARED, table: "thoughts", limit: "10", mode: "hybrid" },
      ADMIN_AUTH,
    );
    const scoped = await callSearch(
      deps,
      { q: TOKEN, namespace: SCOPED, table: "thoughts", limit: "10", mode: "hybrid" },
      SCOPED_AUTH,
    );

    const actual = JSON.stringify(
      {
        shared: { status: shared.status, body: shared.body },
        scoped: { status: scoped.status, body: scoped.body },
      },
      null,
      2,
    );

    if (WRITE_MODE) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${actual}\n`, "utf8");
      // Nothing is asserted in write mode: this run is the capture, and the
      // tree it runs in is by design the one whose bytes are being recorded.
      expect(actual.length).toBeGreaterThan(0);
      return;
    }

    const golden = readFileSync(GOLDEN_PATH, "utf8").replace(/\n$/, "");
    expect(actual).toBe(golden);
  });
});

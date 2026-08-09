import { describe, expect, test } from "bun:test";
import {
  EVAL_NAMESPACE_PREFIX,
  NamespacePurgeRefused,
  assertPurgeableNamespace,
  countNamespaceResidue,
  purgeNamespace,
} from "../namespace-purge.ts";
import { makeRunId, runNamespaces } from "../config.ts";

/**
 * The prefix guard is the whole authority for auto-removal here
 * (`docs/issue-graph.md` ledger item 20, condition 2: "prefix-guarded so it
 * structurally cannot name anything it did not create"). These tests exist so
 * that claim is EXERCISED rather than asserted, and so they run with no
 * database at all — a guard reachable only behind a live connection is a guard
 * nobody fires, and an unfired guard is the one that turns out to be wrong.
 *
 * Following `server/tools/search-read-scope.test.ts`, the purge tests assert on
 * the SQL and bound parameters the code actually sends, not merely on its
 * return value: a namespace predicate is only a boundary if it is in the
 * statement.
 */
describe("assertPurgeableNamespace", () => {
  test("accepts the namespaces the eval config actually generates", () => {
    for (const label of ["scenario-abc123", "live578", "epic336kw"]) {
      const { primary, negative } = runNamespaces(
        makeRunId({ prefix: label, randomHex: "0123456789ab", env: {} }),
      );
      expect(() => assertPurgeableNamespace(primary)).not.toThrow();
      expect(() => assertPurgeableNamespace(negative)).not.toThrow();
    }
  });

  test.each([
    ["an operator namespace", "rico"],
    ["the shared knowledge base", "shared-kb"],
    ["a bare empty string", ""],
    ["one character off the prefix", "eval-live-recal-abc123"],
    ["a different eval family", "eval-kwdiag-1889c167"],
  ])("refuses %s", (_label, namespace) => {
    expect(() => assertPurgeableNamespace(namespace)).toThrow(
      NamespacePurgeRefused,
    );
  });

  test("refuses the bare prefix, which no run ever produces", () => {
    // `runNamespaces` always appends a nonce, so the bare prefix names nothing
    // this process created. Accepting it would mean accepting a name that could
    // only have come from somewhere else.
    expect(() => assertPurgeableNamespace(EVAL_NAMESPACE_PREFIX)).toThrow(
      NamespacePurgeRefused,
    );
  });

  test("refuses a name that merely CONTAINS the prefix", () => {
    // The specific defect a `.includes()` guard ships with.
    expect(() =>
      assertPurgeableNamespace(`not-${EVAL_NAMESPACE_PREFIX}abc123`),
    ).toThrow(NamespacePurgeRefused);
    expect(() =>
      assertPurgeableNamespace(`rico-${EVAL_NAMESPACE_PREFIX}abc123`),
    ).toThrow(NamespacePurgeRefused);
  });

  test("the refusal message carries no namespace content", () => {
    // A refusal can be pointed at an operator's real namespace, so the message
    // must not echo it into a log or a receipt.
    const secret = "rico-private-namespace";
    let message = "";
    try {
      assertPurgeableNamespace(secret);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).toContain("REFUSED");
  });
});

describe("purgeNamespace", () => {
  test("refuses BEFORE issuing any statement", async () => {
    // The mutation proof, in unit form: a pool that throws on ANY query. If the
    // guard ran after the first DELETE, this would surface as the pool's error
    // rather than the refusal.
    const exploding = {
      query: () => {
        throw new Error("purgeNamespace issued a statement on a refused name");
      },
    } as never;

    await expect(purgeNamespace(exploding, "rico")).rejects.toThrow(
      NamespacePurgeRefused,
    );
  });

  test("every statement is a namespace-parameterized DELETE", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const recording = {
      query: (sql: string, params: unknown[]) => {
        seen.push({ sql, params });
        return Promise.resolve({ rowCount: 1 });
      },
    } as never;

    const namespace = runNamespaces(
      makeRunId({ prefix: "scenario-unit", randomHex: "0123456789ab", env: {} }),
    ).primary;
    const result = await purgeNamespace(recording, namespace);

    expect(seen.length).toBeGreaterThan(0);
    expect(result.deleted).toBe(seen.length);
    for (const call of seen) {
      // No statement may reach a row by any predicate other than this exact
      // namespace, and the namespace is bound, never interpolated.
      expect(call.sql).toContain("DELETE FROM");
      expect(call.sql).toContain("WHERE namespace = $1");
      expect(call.params).toEqual([namespace]);
    }
  });

  test("records a failing table instead of aborting the rest", async () => {
    // A partially-purged namespace still needs its tally reported; swallowing
    // the remainder is the defect #655 is about.
    let calls = 0;
    const flaky = {
      query: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("boom"));
        return Promise.resolve({ rowCount: 0 });
      },
    } as never;

    const namespace = runNamespaces(
      makeRunId({ prefix: "scenario-unit", randomHex: "0123456789ab", env: {} }),
    ).primary;
    const result = await purgeNamespace(flaky, namespace);

    expect(Object.keys(result.failed_tables)).toHaveLength(1);
    // The error CLASS, never the driver's message, which can echo row content.
    expect(Object.values(result.failed_tables)).toEqual(["TypeError"]);
    expect(calls).toBeGreaterThan(1);
  });

  test("reports zero deletions without inventing a table entry", async () => {
    const empty = {
      query: () => Promise.resolve({ rowCount: 0 }),
    } as never;

    const namespace = runNamespaces(
      makeRunId({ prefix: "scenario-unit", randomHex: "0123456789ab", env: {} }),
    ).primary;
    const result = await purgeNamespace(empty, namespace);

    expect(result.deleted).toBe(0);
    expect(result.deleted_by_table).toEqual({});
    expect(result.failed_tables).toEqual({});
    expect(result.namespace).toBe(namespace);
  });
});

/**
 * Issue #671: the teardown VERDICT now rests on this counter rather than on a
 * tally of cleanup calls, so what it reads and what it does when it cannot read
 * are both load-bearing.
 */
describe("countNamespaceResidue", () => {
  test("counts every table the purge deletes from — one list, two readers", async () => {
    // Drift between a purge list and a residue list fails silently and GREEN: a
    // table the purge stopped clearing would also stop being counted.
    const purgeTables: string[] = [];
    const recordingPurge = {
      query: (sql: string) => {
        purgeTables.push(sql.replace(/^DELETE FROM (\w+).*$/s, "$1"));
        return Promise.resolve({ rowCount: 0 });
      },
    } as never;
    const residueTables: string[] = [];
    const recordingResidue = {
      query: (sql: string) => {
        residueTables.push(sql.replace(/^SELECT count\(\*\)::int AS n FROM (\w+).*$/s, "$1"));
        return Promise.resolve({ rows: [{ n: 0 }] });
      },
    } as never;

    const namespace = runNamespaces(
      makeRunId({ prefix: "scenario-unit", randomHex: "0123456789ab", env: {} }),
    ).primary;
    await purgeNamespace(recordingPurge, namespace);
    await countNamespaceResidue(recordingResidue, namespace);

    expect(residueTables).toEqual(purgeTables);
    expect(residueTables.length).toBeGreaterThan(0);
  });

  test("binds the namespace and never mutates", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const recording = {
      query: (sql: string, params: unknown[]) => {
        seen.push({ sql, params });
        return Promise.resolve({ rows: [{ n: 3 }] });
      },
    } as never;

    const namespace = runNamespaces(
      makeRunId({ prefix: "scenario-unit", randomHex: "0123456789ab", env: {} }),
    ).primary;
    const result = await countNamespaceResidue(recording, namespace);

    for (const call of seen) {
      expect(call.sql).toContain("SELECT count(*)");
      expect(call.sql).not.toContain("DELETE");
      expect(call.sql).toContain("WHERE namespace = $1");
      expect(call.params).toEqual([namespace]);
    }
    expect(result.rows).toBe(3 * seen.length);
  });

  test("records an unreadable table by class instead of reporting it as zero", async () => {
    // Counting an unreadable table as zero is how a residue reading would go
    // clean over exactly the rows it exists to find.
    let calls = 0;
    const flaky = {
      query: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("boom"));
        return Promise.resolve({ rows: [{ n: 0 }] });
      },
    } as never;

    const namespace = runNamespaces(
      makeRunId({ prefix: "scenario-unit", randomHex: "0123456789ab", env: {} }),
    ).primary;
    const result = await countNamespaceResidue(flaky, namespace);

    expect(Object.keys(result.unreadable_tables)).toHaveLength(1);
    expect(Object.values(result.unreadable_tables)).toEqual(["TypeError"]);
    expect(result.rows).toBe(0);
  });
});

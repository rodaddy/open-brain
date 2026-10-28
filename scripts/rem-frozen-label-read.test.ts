import { beforeEach, describe, expect, test, vi } from "vitest";

import type { FrozenCohort } from "./rem-ethereal-cohort.ts";

const loadFrozenCohort = vi.hoisted(() => vi.fn());
vi.mock("./rem-ethereal-cohort.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rem-ethereal-cohort.ts")>()),
  loadFrozenCohort,
}));

import { loadFrozenHumanLabels } from "./rem-frozen-label-read.ts";

const schema = "dream_run_001";
const namespace = "human-review";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const frozen: FrozenCohort = {
  schema,
  namespace,
  digest: "cohort-digest",
  fullSnapshotSha256: "snapshot-sha",
  candidates: [
    { id: firstId, namespace, content_hash: "hash-1" },
    { id: secondId, namespace, content_hash: "hash-2" },
  ] as FrozenCohort["candidates"],
};

const validRow = {
  run_id: schema,
  candidate_id: firstId,
  namespace,
  cohort_digest: frozen.digest,
  full_snapshot_sha256: frozen.fullSnapshotSha256,
  content_hash: "hash-1",
  grade: "promoted",
  note: "Exact frozen evidence supports it.",
  graded_by: "dana",
  graded_at: new Date("2026-09-20T12:00:00.000Z"),
};

function fakeLabelQuery(rows: unknown[], hasScopeMismatch = false) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ has_scope_mismatch: hasScopeMismatch }] };
    }
    return { rows };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadFrozenCohort.mockResolvedValue(frozen);
});

describe("loadFrozenHumanLabels", () => {
  test("loads namespace-scoped labels bound to the verified frozen cohort", async () => {
    const query = fakeLabelQuery([validRow]);

    await expect(
      loadFrozenHumanLabels({ query } as never, schema, namespace),
    ).resolves.toEqual({
      status: "labels_loaded",
      schema,
      namespace,
      cohortDigest: frozen.digest,
      fullSnapshotSha256: frozen.fullSnapshotSha256,
      labels: [
        {
          candidate_id: firstId,
          grade: "promoted",
          note: validRow.note,
          graded_by: "dana",
          graded_at: validRow.graded_at,
        },
      ],
    });
    expect(loadFrozenCohort).toHaveBeenCalledWith(expect.anything(), schema, namespace);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /FROM dream_run_001\.human_label[\s\S]*WHERE run_id = \$1 AND namespace = \$2/,
      ),
      [schema, namespace],
    );
  });

  test("reports an absent label table as explicit empty labels", async () => {
    const missingTable = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const query = vi.fn().mockRejectedValue(missingTable);

    await expect(
      loadFrozenHumanLabels({ query } as never, schema, namespace),
    ).resolves.toEqual({
      status: "label_table_absent",
      schema,
      namespace,
      cohortDigest: frozen.digest,
      fullSnapshotSha256: frozen.fullSnapshotSha256,
      labels: [],
    });
  });

  test.each([
    ["run", { run_id: "dream_run_002" }],
    ["namespace", { namespace: "other" }],
    ["cohort digest", { cohort_digest: "stale" }],
    ["snapshot digest", { full_snapshot_sha256: "stale" }],
    ["candidate", { candidate_id: "33333333-3333-4333-8333-333333333333" }],
    ["content hash", { content_hash: "stale" }],
    ["grade", { grade: "approved" }],
  ])("rejects a corrupt or stale %s row", async (_field, mutation) => {
    const query = fakeLabelQuery([{ ...validRow, ...mutation }]);

    await expect(
      loadFrozenHumanLabels({ query } as never, schema, namespace),
    ).rejects.toThrow(/frozen human label/i);
  });

  test("rejects duplicate returned candidate labels", async () => {
    const query = fakeLabelQuery([validRow, validRow]);
    await expect(
      loadFrozenHumanLabels({ query } as never, schema, namespace),
    ).rejects.toThrow(/duplicate/i);
  });

  test("rejects corrupt rows hidden by the scoped label query", async () => {
    const query = fakeLabelQuery([], true);

    await expect(
      loadFrozenHumanLabels({ query } as never, schema, namespace),
    ).rejects.toThrow(/scope mismatch/i);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /SELECT EXISTS[\s\S]*run_id IS DISTINCT FROM \$1[\s\S]*namespace IS DISTINCT FROM \$2/,
      ),
      [schema, namespace],
    );
  });

  test("rejects an invalid schema before cohort or label queries", async () => {
    const query = vi.fn();
    await expect(
      loadFrozenHumanLabels({ query } as never, "public", namespace),
    ).rejects.toThrow(/schema/i);
    expect(loadFrozenCohort).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

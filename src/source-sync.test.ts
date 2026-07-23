import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  observationHash,
  planReconciliation,
  sourceObservationSchema,
  syncSource,
  type SourceObservation,
  type SyncOp,
} from "./source-sync.ts";
import type { AuthInfo } from "./types.ts";

// Deterministic id minter so an `add` produces a stable, inspectable file_id.
function seqMinter(prefix = "new"): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

const H = (n: number): string => n.toString(16).padStart(64, "0");

function obs(files: Array<[string, string]>): SourceObservation {
  return {
    files: files.map(([path, content_hash]) => ({ path, content_hash })),
  };
}

function byKind(ops: SyncOp[], kind: SyncOp["kind"]): SyncOp[] {
  return ops.filter((o) => o.kind === kind);
}

describe("planReconciliation - reconciliation behavior", () => {
  it("adds every observed file when the manifest is empty", () => {
    const { ops, unchanged } = planReconciliation(
      [],
      obs([
        ["a.ts", H(1)],
        ["b.ts", H(2)],
      ]),
      seqMinter(),
    );
    expect(unchanged).toBe(0);
    const adds = byKind(ops, "add");
    expect(adds.map((o) => o.path).sort()).toEqual(["a.ts", "b.ts"]);
    // Every add carries a freshly minted durable id.
    expect(new Set(adds.map((o) => o.file_id)).size).toBe(2);
  });

  it("emits no op for an unchanged file (same path, same hash)", () => {
    const { ops, unchanged } = planReconciliation(
      [{ file_id: "f1", path: "a.ts", content_hash: H(1) }],
      obs([["a.ts", H(1)]]),
      seqMinter(),
    );
    expect(ops).toEqual([]);
    expect(unchanged).toBe(1);
  });

  it("edits a file whose content changed at the same path, preserving identity", () => {
    const { ops } = planReconciliation(
      [{ file_id: "f1", path: "a.ts", content_hash: H(1) }],
      obs([["a.ts", H(9)]]),
      seqMinter(),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "edit",
      file_id: "f1",
      path: "a.ts",
      content_hash: H(9),
    });
  });

  it("detects a rename (path moved, content identical) and preserves file_id", () => {
    const { ops } = planReconciliation(
      [{ file_id: "f1", path: "old.ts", content_hash: H(1) }],
      obs([["new.ts", H(1)]]),
      seqMinter(),
    );
    const renames = byKind(ops, "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      kind: "rename",
      file_id: "f1",
      path: "new.ts",
      prev_path: "old.ts",
    });
    // A rename is NOT a delete+add: no add, no delete.
    expect(byKind(ops, "add")).toHaveLength(0);
    expect(byKind(ops, "delete")).toHaveLength(0);
  });

  it("deletes a file whose path vanished with no matching content", () => {
    const { ops } = planReconciliation(
      [{ file_id: "f1", path: "gone.ts", content_hash: H(1) }],
      obs([]),
      seqMinter(),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "delete",
      file_id: "f1",
      path: "gone.ts",
    });
  });

  it("swap of contents at fixed paths is two edits, never a rename", () => {
    const { ops } = planReconciliation(
      [
        { file_id: "fa", path: "x.ts", content_hash: H(1) },
        { file_id: "fb", path: "y.ts", content_hash: H(2) },
      ],
      obs([
        ["x.ts", H(2)],
        ["y.ts", H(1)],
      ]),
      seqMinter(),
    );
    expect(byKind(ops, "edit")).toHaveLength(2);
    expect(byKind(ops, "rename")).toHaveLength(0);
    expect(byKind(ops, "add")).toHaveLength(0);
    expect(byKind(ops, "delete")).toHaveLength(0);
  });

  it("a vanished file plus an unrelated new file is one delete + one add, not a rename", () => {
    const { ops } = planReconciliation(
      [{ file_id: "f1", path: "gone.ts", content_hash: H(1) }],
      obs([["fresh.ts", H(2)]]),
      seqMinter(),
    );
    expect(byKind(ops, "delete").map((o) => o.file_id)).toEqual(["f1"]);
    expect(byKind(ops, "add").map((o) => o.path)).toEqual(["fresh.ts"]);
    expect(byKind(ops, "rename")).toHaveLength(0);
  });

  it("mixed add/edit/rename/delete in one plan", () => {
    const { ops, unchanged } = planReconciliation(
      [
        { file_id: "keep", path: "keep.ts", content_hash: H(1) }, // unchanged
        { file_id: "edit", path: "edit.ts", content_hash: H(2) }, // edited
        { file_id: "move", path: "old.ts", content_hash: H(3) }, // renamed
        { file_id: "drop", path: "drop.ts", content_hash: H(4) }, // deleted
      ],
      obs([
        ["keep.ts", H(1)],
        ["edit.ts", H(20)],
        ["new.ts", H(3)],
        ["added.ts", H(5)],
      ]),
      seqMinter(),
    );
    expect(unchanged).toBe(1);
    expect(byKind(ops, "edit").map((o) => o.file_id)).toEqual(["edit"]);
    expect(byKind(ops, "rename").map((o) => o.file_id)).toEqual(["move"]);
    expect(byKind(ops, "delete").map((o) => o.file_id)).toEqual(["drop"]);
    expect(byKind(ops, "add").map((o) => o.path)).toEqual(["added.ts"]);
  });

  it("emits deletes before renames before adds (path-collision-safe apply order)", () => {
    // A plan that contains a delete, a rename, and an add together. The emission
    // order [edits, deletes, renames, adds] guarantees a path a delete frees is
    // available before a later rename/add could reuse it.
    const { ops } = planReconciliation(
      [
        { file_id: "drop", path: "drop.ts", content_hash: H(4) }, // deleted
        { file_id: "move", path: "old.ts", content_hash: H(3) }, // renamed
      ],
      obs([
        ["moved.ts", H(3)], // rename target of 'move'
        ["fresh.ts", H(5)], // add
      ]),
      seqMinter(),
    );
    const kinds = ops.map((o) => o.kind);
    const delIdx = kinds.indexOf("delete");
    const renIdx = kinds.indexOf("rename");
    const addIdx = kinds.indexOf("add");
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(renIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeLessThan(renIdx);
    expect(renIdx).toBeLessThan(addIdx);
    // Rename preserves durable identity onto the new path.
    expect(ops[renIdx]).toMatchObject({ file_id: "move", path: "moved.ts" });
  });

  it("is deterministic: identical inputs yield a byte-identical plan (resume-safe)", () => {
    const manifest = [
      { file_id: "f2", path: "b.ts", content_hash: H(2) },
      { file_id: "f1", path: "a.ts", content_hash: H(1) },
    ];
    const observation = obs([
      ["a.ts", H(10)],
      ["b.ts", H(2)],
      ["c.ts", H(3)],
    ]);
    // Same minter sequence both times so the derived plan is comparable.
    const first = planReconciliation(manifest, observation, seqMinter());
    const second = planReconciliation(manifest, observation, seqMinter());
    expect(JSON.stringify(first.ops)).toEqual(JSON.stringify(second.ops));
  });
});

describe("observationHash - order-insensitive, content-free", () => {
  it("is stable regardless of observed file order", () => {
    const a = observationHash(
      obs([
        ["a.ts", H(1)],
        ["b.ts", H(2)],
      ]),
    );
    const b = observationHash(
      obs([
        ["b.ts", H(2)],
        ["a.ts", H(1)],
      ]),
    );
    expect(a).toEqual(b);
  });

  it("changes when any path or hash changes", () => {
    const base = observationHash(obs([["a.ts", H(1)]]));
    expect(observationHash(obs([["a.ts", H(2)]]))).not.toEqual(base);
    expect(observationHash(obs([["b.ts", H(1)]]))).not.toEqual(base);
  });

  it("is a lowercase sha256 hex digest", () => {
    expect(observationHash(obs([["a.ts", H(1)]]))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same file set hashes identically every call", () => {
    const files = obs([
      ["src/a.ts", H(1)],
      ["src/b.ts", H(2)],
      ["deep/nested path.ts", H(3)],
    ]);
    expect(observationHash(files)).toEqual(observationHash(files));
  });

  it("does not collide when a delimiter could fuse path and hash fields", () => {
    // The canonical encoding must treat (path, content_hash) as separate fields.
    // A naive `${path}${hash}` or space-joined encoding would let two DIFFERENT
    // observations serialize to the same bytes. Prove those inputs stay distinct.
    //
    // Boundary shift: same characters, different field split.
    const a = observationHash(obs([["ab", H(1)]]));
    const b = observationHash(obs([["a", `b${H(1)}`.slice(0, 64)]]));
    expect(a).not.toEqual(b);

    // A path that literally contains the neighbouring encoding must not let one
    // file masquerade as two (or two as one).
    const single = observationHash(obs([[`x", "${H(2)}`, H(1)]]));
    const paired = observationHash(
      obs([
        ["x", H(2)],
        ["", H(1)],
      ]),
    );
    expect(single).not.toEqual(paired);
  });

  it("distinguishes a path/hash swap that a symmetric join would collapse", () => {
    // ("a.ts", H1)+("b.ts", H2) must not equal ("a.ts", H2)+("b.ts", H1): the
    // pair binding, not just the multiset of tokens, is part of the identity.
    const straight = observationHash(
      obs([
        ["a.ts", H(1)],
        ["b.ts", H(2)],
      ]),
    );
    const swapped = observationHash(
      obs([
        ["a.ts", H(2)],
        ["b.ts", H(1)],
      ]),
    );
    expect(straight).not.toEqual(swapped);
  });
});

describe("source-sync.ts source file is reviewable text (no binary bytes)", () => {
  // The observation-hash encoding once used a literal NUL delimiter, which made
  // Git classify this module as a binary blob and defeated line diff/blame/review.
  // Assert the SOURCE BYTES contain no NUL or C0 control byte (tab/newline/CR
  // excepted) so the file stays a reviewable text source. Reviewability is the
  // user-visible defect here, so a source-byte assertion is the right check.
  it("contains no NUL or disallowed control bytes", () => {
    const path = fileURLToPath(new URL("./source-sync.ts", import.meta.url));
    const bytes = readFileSync(path);
    const offending: number[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!;
      const isAllowedControl = b === 0x09 || b === 0x0a || b === 0x0d;
      if (b < 0x20 && !isAllowedControl) offending.push(b);
      if (b === 0x7f) offending.push(b);
    }
    expect(offending).toEqual([]);
  });
});

describe("sourceObservationSchema - content-free input validation", () => {
  it("accepts a well-formed {path, content_hash} set", () => {
    expect(
      sourceObservationSchema.safeParse({
        files: [{ path: "a.ts", content_hash: H(1) }],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-sha256 content_hash (no arbitrary opaque strings)", () => {
    expect(
      sourceObservationSchema.safeParse({
        files: [{ path: "a.ts", content_hash: "not-a-hash" }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (no body smuggling)", () => {
    expect(
      sourceObservationSchema.safeParse({
        files: [{ path: "a.ts", content_hash: H(1), body: "secret" }],
      }).success,
    ).toBe(false);
  });
});

describe("syncSource - duplicate observed paths are rejected with zero mutation", () => {
  // A pool that fails loudly if anyone tries to open a DB connection. A duplicate
  // path must be rejected BEFORE planning/mutation, so connect() is never called.
  function poisonPool(): { connect: () => Promise<never> } {
    return {
      connect: () => {
        throw new Error("connect() must not be called: no mutation on reject");
      },
    };
  }

  const admin: AuthInfo = {
    role: "admin",
    clientId: "lane338-dupe",
    namespaceSource: "token",
  };

  it("returns invalid_observation and never opens a connection", async () => {
    const res = await syncSource(
      poisonPool() as never,
      admin,
      "00000000-0000-0000-0000-000000000000",
      {
        files: [
          { path: "dup.ts", content_hash: H(1) },
          { path: "dup.ts", content_hash: H(2) },
        ],
      },
      { target_namespace: "lane338-dupe-ns" },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_observation");
    // Zero mutation: connect() would have thrown had planning proceeded, so a
    // clean rejection here proves nothing touched the database.
    expect(res.data).toBeUndefined();
  });

  it("allows a distinct-path observation to proceed to the DB layer", async () => {
    // Same shape, but paths are distinct — the duplicate guard must NOT trip, so
    // execution reaches connect() (which our poison pool throws on). This proves
    // the guard rejects duplicates specifically, not every observation.
    await expect(
      syncSource(
        poisonPool() as never,
        admin,
        "00000000-0000-0000-0000-000000000000",
        {
          files: [
            { path: "a.ts", content_hash: H(1) },
            { path: "b.ts", content_hash: H(2) },
          ],
        },
        { target_namespace: "lane338-dupe-ns" },
      ),
    ).rejects.toThrow("connect() must not be called");
  });
});

describe("syncSource - dependency failure is content-free (sentinel)", () => {
  const admin: AuthInfo = {
    role: "admin",
    clientId: "lane338-fail",
    namespaceSource: "token",
  };

  // A leaky pg-shaped error: `message`/`detail`/`query` echo the kind of content
  // (paths, SQL, parameter values) that must NEVER escape this substrate. `.name`
  // and `.code` are the only allowlisted, content-free fields.
  const SECRET = "/secret/absolute/path/with-body-bytes.ts";
  function leakyPgError(): Error {
    const err = Object.assign(new Error(`duplicate key value: ${SECRET}`), {
      name: "error",
      code: "23505",
      detail: `Key (path)=(${SECRET}) already exists.`,
      query: `INSERT INTO ob_source_files ... '${SECRET}'`,
      where: SECRET,
    });
    return err;
  }

  // A client that BEGINs fine, then throws the leaky error on the first non-BEGIN
  // statement — simulating a mid-transaction dependency failure. ROLLBACK resolves.
  function failingPool(err: Error): { connect: () => Promise<unknown> } {
    return {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
          throw err;
        },
        release: () => undefined,
      }),
    };
  }

  it("returns sync_failed instead of rethrowing the raw dependency error", async () => {
    const res = await syncSource(
      failingPool(leakyPgError()) as never,
      admin,
      "00000000-0000-0000-0000-000000000000",
      { files: [{ path: "a.ts", content_hash: H(1) }] },
      { target_namespace: "lane338-fail-ns" },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("sync_failed");
    // The result carries no receipt and, crucially, no leaked content: the whole
    // serialized result must not contain the secret path or any raw driver detail.
    expect(res.data).toBeUndefined();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("duplicate key");
    expect(serialized).not.toContain("INSERT INTO");
  });
});

import { describe, expect, it } from "bun:test";
import {
  observationHash,
  planReconciliation,
  sourceObservationSchema,
  type SourceObservation,
  type SyncOp,
} from "./source-sync.ts";

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

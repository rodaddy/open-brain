import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDropFolder,
  resolveEligibleDropSource,
  type DropCollectorPool,
} from "./drop-folder-collector.ts";
import { contentHash } from "./embedding.ts";
import type { AuthInfo } from "./types.ts";

// A drop body sentinel. It is the raw file content the server reads; it must
// never appear in any receipt, counter, code, or log line. Only its opaque
// digest and structural counts may travel. The absolute/relative path must also
// never appear.
const BODY_A = "PRIVATE_DROP_BODY_do_not_leak: quarterly plan for 2026-05-01";
const BODY_B = "SECOND_DROP_BODY_do_not_leak: different content entirely here";

const adminAuth: AuthInfo = {
  role: "admin",
  clientId: "admin-client",
  namespaceSource: "token",
};

// readonly caller: may read its own namespace but cannot write anywhere.
const readonlyAuth: AuthInfo = {
  role: "readonly",
  clientId: "admin-client",
  namespaceSource: "token",
};

// agent caller in shared-kb: can read shared-kb but is not a promoter identity,
// so it cannot write shared-kb.
const agentAuth: AuthInfo = {
  role: "agent",
  clientId: "agent-client",
  namespaceSource: "token",
};

interface SourceRow {
  id: string;
  namespace: string;
  source_kind: string;
  external_id: string;
  title: string | null;
  scope: Record<string, string>;
  approval_state: string;
  approved_by: string | null;
  approved_at: string | null;
  lifecycle_state: string;
  sync_state: string;
  language: string | null;
  config: Record<string, unknown>;
  content_hash: string | null;
  last_synced_at: string | null;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ThoughtRow {
  id: string;
  content: string;
  tags: string[];
  namespace: string;
  content_hash: string;
}

// A minimal stateful fake modeling the two tables the collector touches:
//  - ob_sources: the registry gate (resolveIngestionEligibility SELECT) and the
//    hash re-stamp (updateSource UPDATE + probe).
//  - thoughts: the durable upsert, including the (content_hash, namespace)
//    ON CONFLICT dedupe that makes identical content merge instead of insert.
// It routes on stable substrings of the collector's own parameterized SQL, so
// the test exercises real behavior (dedupe, hash advance) rather than SQL shape.
// The `thoughts` array is the durable ground truth every assertion checks: no
// duplicate rows, correct namespaces, no bodies leaking to receipts.
function makeFake(source: Partial<SourceRow> & { external_id: string }) {
  const src: SourceRow = {
    id: "11111111-1111-1111-1111-111111111111",
    namespace: "admin-client",
    source_kind: "drop",
    title: "Drop A",
    scope: {},
    approval_state: "approved",
    approved_by: "admin-client",
    approved_at: "2026-01-01T00:00:00.000Z",
    lifecycle_state: "active",
    sync_state: "never_synced",
    language: null,
    config: {},
    content_hash: null,
    last_synced_at: null,
    revision: 1,
    created_by: "admin-client",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...source,
  };
  const thoughts: ThoughtRow[] = [];
  let idSeq = 0;

  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      // Registry ingestion gate: SELECT ... WHERE namespace/source_kind/external_id
      if (
        sql.includes("FROM ob_sources") &&
        sql.includes(
          "WHERE namespace = $1 AND source_kind = $2 AND external_id = $3",
        )
      ) {
        const [ns, kind, ext] = params as [string, string, string];
        if (
          src.namespace === ns &&
          src.source_kind === kind &&
          src.external_id === ext
        ) {
          return { rows: [{ ...src }] };
        }
        return { rows: [] };
      }

      // Durable upsert into thoughts with content-hash dedupe.
      if (sql.includes("INSERT INTO thoughts")) {
        const [content, tags, , namespace, , hash] = params as [
          string,
          string[],
          unknown,
          string,
          unknown,
          string,
        ];
        const existing = thoughts.find(
          (t) => t.content_hash === hash && t.namespace === namespace,
        );
        if (existing) {
          // ON CONFLICT DO UPDATE: merge distinct tags, keep id, is_new=false.
          for (const tag of tags) {
            if (!existing.tags.includes(tag)) existing.tags.push(tag);
          }
          return { rows: [{ id: existing.id, is_new: false }] };
        }
        const id = `thought-${++idSeq}`;
        thoughts.push({
          id,
          content,
          tags: [...tags],
          namespace,
          content_hash: hash,
        });
        return { rows: [{ id, is_new: true }] };
      }

      // Background extraction UPDATE (fire-and-forget). Ignore.
      if (sql.includes("UPDATE thoughts AS t")) {
        return { rows: [] };
      }

      // Registry updateSource UPDATE (hash re-stamp).
      if (
        sql.includes("UPDATE ob_sources") &&
        sql.includes("WHERE id = $1 AND namespace = $2 AND revision = $3")
      ) {
        const [id, ns, rev] = params as [string, string, number];
        if (src.id === id && src.namespace === ns && src.revision === rev) {
          const rest = (params as unknown[]).slice(3);
          for (const v of rest) {
            if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) {
              src.content_hash = v;
            } else if (typeof v === "string" && v.includes("T")) {
              src.last_synced_at = v;
            } else if (
              typeof v === "string" &&
              ["synced", "syncing", "error", "never_synced"].includes(v)
            ) {
              src.sync_state = v;
            }
          }
          src.revision += 1;
          return { rows: [{ ...src }] };
        }
        return { rows: [] };
      }

      // updateSource existence probe (only hit when the UPDATE matched nothing).
      if (sql.includes("SELECT revision, lifecycle_state FROM ob_sources")) {
        const [id, ns] = params as [string, string];
        if (src.id === id && src.namespace === ns) {
          return {
            rows: [
              { revision: src.revision, lifecycle_state: src.lifecycle_state },
            ],
          };
        }
        return { rows: [] };
      }

      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };

  // The fake's query is a stable-substring router, not pg's overloaded signature;
  // cast to the minimal DropCollectorPool the collector actually uses.
  return { pool: pool as unknown as DropCollectorPool, thoughts, src };
}

const embedFn = async () => null;

function assertContentFree(value: unknown, root: string, relPaths: string[]) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(BODY_A);
  expect(serialized).not.toContain(BODY_B);
  expect(serialized).not.toContain("PRIVATE_DROP_BODY");
  expect(serialized).not.toContain("SECOND_DROP_BODY");
  // The folder path and every file path must never appear.
  expect(serialized).not.toContain(root);
  for (const rel of relPaths) {
    expect(serialized).not.toContain(rel);
  }
}

// --- real temp filesystem lifecycle ---------------------------------------
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "drop-collector-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("drop-folder collector — eligibility + write authority", () => {
  it("rejects an unregistered drop source before touching the folder", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const { pool, thoughts } = makeFake({ external_id: "drop-a" });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-UNKNOWN",
    });
    expect(result.ok).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("not_found");
    expect(result.files).toBeUndefined();
    // No durable write happened; the folder was never read.
    expect(thoughts.length).toBe(0);
    assertContentFree(result, root, ["a.txt"]);
  });

  it("rejects a registered-but-unapproved (pending) drop source before read", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      approval_state: "pending",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.ok).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("approval_denied");
    expect(thoughts.length).toBe(0);
  });

  it("rejects a retired/paused (not active) approved source before read", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      approval_state: "approved",
      lifecycle_state: "paused",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("approval_denied");
    expect(thoughts.length).toBe(0);
  });

  it("denies a read-authorized but write-unauthorized readonly caller with zero writes", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    // Source lives in the readonly caller's OWN namespace, so eligibility (read)
    // passes; canWriteNamespace must still deny because readonly cannot write.
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      namespace: "admin-client",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, readonlyAuth, {
      external_id: "drop-a",
    });
    expect(result.ok).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("namespace_denied");
    // Zero durable rows: the write check ran BEFORE any file read.
    expect(thoughts.length).toBe(0);
  });

  it("denies an agent caller writing shared-kb (read-authorized, not a promoter) with zero writes", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const { pool, thoughts } = makeFake({
      external_id: "drop-shared",
      namespace: "shared-kb",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, agentAuth, {
      external_id: "drop-shared",
      target_namespace: "shared-kb",
    });
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("namespace_denied");
    expect(thoughts.length).toBe(0);
  });

  it("denies ALL roles writing the frozen 'collab' namespace with zero writes", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const { pool, thoughts } = makeFake({
      external_id: "drop-collab",
      namespace: "collab",
      config: { root },
    });
    // Even an admin cannot write the frozen collab snapshot.
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-collab",
      target_namespace: "collab",
    });
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("namespace_denied");
    expect(thoughts.length).toBe(0);
  });

  it("resolveEligibleDropSource surfaces write denial independently of read eligibility", async () => {
    const { pool } = makeFake({
      external_id: "drop-a",
      namespace: "admin-client",
      config: { root },
    });
    const gate = await resolveEligibleDropSource(pool, readonlyAuth, "drop-a");
    expect(gate.eligible).toBe(false);
    if (!gate.eligible) expect(gate.code).toBe("namespace_denied");
  });
});

describe("drop-folder collector — server-side discovery + ingestion", () => {
  it("ingests real files placed under the approved root with extracted metadata and content-free receipts", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    await writeFile(join(root, "b.md"), BODY_B);
    const { pool, thoughts, src } = makeFake({
      external_id: "drop-a",
      config: { root },
    });

    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
      tags: ["drop"],
    });

    expect(result.ok).toBe(true);
    expect(result.eligible).toBe(true);
    expect(result.collected).toBe(2);
    expect(result.deduped).toBe(0);
    // Two distinct durable rows, both in the source's namespace.
    expect(thoughts.length).toBe(2);
    expect(thoughts.every((t) => t.namespace === "admin-client")).toBe(true);
    // The durable rows carry the ACTUAL file bodies the server read (proving it
    // discovered and read the files itself, not caller-supplied bodies).
    const contents = thoughts.map((t) => t.content).sort();
    expect(contents).toEqual([BODY_A, BODY_B].sort());
    // Durable content_hash is the normalized durable identity.
    expect(thoughts.some((t) => t.content_hash === contentHash(BODY_A))).toBe(
      true,
    );
    // Source content_hash was stamped to a manifest digest (not a raw body hash).
    expect(src.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // Receipts carry opaque tokens + digests only.
    for (const f of result.files ?? []) {
      expect(f.file_token).toMatch(/^[0-9a-f]{64}$/);
    }
    assertContentFree(result, root, ["a.txt", "b.md"]);
  });

  it("discovers files in nested subdirectories within the depth bound", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "top.txt"), BODY_A);
    await writeFile(join(root, "sub", "nested.md"), BODY_B);
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.collected).toBe(2);
    expect(thoughts.length).toBe(2);
  });

  it("skips unsupported file types truthfully without reading them", async () => {
    await writeFile(join(root, "keep.txt"), BODY_A);
    await writeFile(join(root, "skip.bin"), BODY_B);
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.collected).toBe(1);
    // The .bin was not discovered as supported, so no receipt/skip for it and no
    // durable row. Only the .txt landed.
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.content).toBe(BODY_A);
    assertContentFree(result, root, ["keep.txt", "skip.bin"]);
  });

  it("returns no_root when the approved source has no configured folder root", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      config: {}, // no root
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.ok).toBe(false);
    expect(result.eligible).toBe(true);
    expect(result.code).toBe("no_root");
    expect(thoughts.length).toBe(0);
  });

  it("returns root_unavailable when the configured root does not exist", async () => {
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      config: { root: join(root, "does-not-exist") },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("root_unavailable");
    expect(thoughts.length).toBe(0);
  });
});

describe("drop-folder collector — traversal + symlink confinement", () => {
  it("does not follow a symlink that escapes the root (symlink-escape rejected)", async () => {
    // Secret file OUTSIDE the root.
    const outside = await mkdtemp(join(tmpdir(), "drop-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), BODY_B);
      // A legitimate in-root file plus a symlink pointing outside the root.
      await writeFile(join(root, "inside.txt"), BODY_A);
      await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      // Only the genuine in-root file is ingested; the escaping symlink's target
      // is never read.
      expect(result.collected).toBe(1);
      expect(thoughts.length).toBe(1);
      expect(thoughts[0]!.content).toBe(BODY_A);
      // The outside secret body never appears anywhere.
      const serialized = JSON.stringify({ result, thoughts });
      expect(serialized).not.toContain(BODY_B);
      expect(serialized).not.toContain("SECOND_DROP_BODY");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked directory that escapes the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "drop-outside-dir-"));
    try {
      await writeFile(join(outside, "secret.md"), BODY_B);
      await writeFile(join(root, "inside.txt"), BODY_A);
      // A directory symlink pointing outside the root.
      await symlink(outside, join(root, "linkdir"));

      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      expect(result.collected).toBe(1);
      expect(thoughts.length).toBe(1);
      expect(thoughts[0]!.content).toBe(BODY_A);
      expect(JSON.stringify(thoughts)).not.toContain(BODY_B);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a configured root that is a symlink to a real dir is honored; files under the real dir ingest", async () => {
    // The registry root points at a symlink whose target is the real folder.
    const realDir = await mkdtemp(join(tmpdir(), "drop-realdir-"));
    try {
      await writeFile(join(realDir, "a.txt"), BODY_A);
      const linkRoot = join(root, "rootlink");
      await symlink(realDir, linkRoot);

      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root: linkRoot },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      // The symlinked root resolves to its real target; files under it ingest.
      expect(result.collected).toBe(1);
      expect(thoughts.length).toBe(1);
    } finally {
      await rm(realDir, { recursive: true, force: true });
    }
  });
});

describe("drop-folder collector — dedupe + normalization truthfulness", () => {
  it("two files with identical content collapse to one durable row; the other is deduped", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    await writeFile(join(root, "copy.txt"), BODY_A); // identical bytes
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    expect(result.collected).toBe(1);
    expect(result.deduped).toBe(1);
    // Exactly one durable row despite two files.
    expect(thoughts.length).toBe(1);
  });

  it("case/whitespace variants collide under the normalized durable identity (no duplicate row)", async () => {
    await writeFile(join(root, "a.txt"), "Hello   World");
    await writeFile(join(root, "b.txt"), "hello world"); // normalizes equal
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      config: { root },
    });
    const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
      external_id: "drop-a",
    });
    // contentHash normalizes case + whitespace, so the two collapse to one row.
    expect(result.collected).toBe(1);
    expect(result.deduped).toBe(1);
    expect(thoughts.length).toBe(1);
  });

  it("a rerun of an unchanged folder is a full no-op: no new durable rows", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    await writeFile(join(root, "b.md"), BODY_B);
    const fake = makeFake({ external_id: "drop-a", config: { root } });

    const first = await collectDropFolder(
      { pool: fake.pool, embedFn },
      adminAuth,
      { external_id: "drop-a" },
    );
    expect(first.collected).toBe(2);
    expect(fake.thoughts.length).toBe(2);

    // Rerun: every file dedupes at the durable row; nothing new is written.
    const second = await collectDropFolder(
      { pool: fake.pool, embedFn },
      adminAuth,
      { external_id: "drop-a" },
    );
    expect(second.collected).toBe(0);
    expect(second.deduped).toBe(2);
    expect(fake.thoughts.length).toBe(2);
  });
});

describe("drop-folder collector — bounds", () => {
  it("skips a file over the per-file byte cap truthfully without reading it", async () => {
    process.env.DROP_COLLECTOR_MAX_FILE_BYTES = "16";
    try {
      await writeFile(join(root, "small.txt"), "tiny ok");
      await writeFile(join(root, "big.txt"), BODY_A); // > 16 bytes
      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      expect(result.collected).toBe(1);
      expect(result.skipped).toBe(1);
      const skip = (result.files ?? []).find((f) => f.status === "skipped");
      expect(skip?.reason).toBe("too_large");
      // Only the small file landed; the big one was never read.
      expect(thoughts.length).toBe(1);
      expect(thoughts[0]!.content).toBe("tiny ok");
      assertContentFree(result, root, ["small.txt", "big.txt"]);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILE_BYTES;
    }
  });

  it("truncates truthfully when more files exist than the count bound", async () => {
    process.env.DROP_COLLECTOR_MAX_FILES = "2";
    try {
      await writeFile(join(root, "a.txt"), "alpha content one");
      await writeFile(join(root, "b.txt"), "bravo content two");
      await writeFile(join(root, "c.txt"), "charlie content three");
      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      expect(result.truncated).toBe(true);
      expect(result.collected).toBe(2);
      // The third file is reported as skipped(count_bound), not silently dropped.
      const countSkips = (result.files ?? []).filter(
        (f) => f.reason === "count_bound",
      );
      expect(countSkips.length).toBe(1);
      expect(thoughts.length).toBe(2);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
    }
  });

  it("stops at the total byte bound and reports the remaining files truthfully", async () => {
    process.env.DROP_COLLECTOR_MAX_TOTAL_BYTES = "20";
    try {
      await writeFile(join(root, "a.txt"), "0123456789"); // 10 bytes
      await writeFile(join(root, "b.txt"), "0123456789"); // 10 bytes -> total 20
      await writeFile(join(root, "c.txt"), "0123456789"); // would exceed 20
      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      // a and b (same content) -> one collected + one deduped, both counted read;
      // c would push past the total bound and is skipped.
      const totalSkips = (result.files ?? []).filter(
        (f) => f.reason === "total_bound",
      );
      expect(totalSkips.length).toBe(1);
      // Only one distinct durable row (a and b are identical content).
      expect(thoughts.length).toBe(1);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_TOTAL_BYTES;
    }
  });
});

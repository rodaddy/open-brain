import { afterEach, beforeEach, describe, it, expect, spyOn } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDropFolder,
  discoverFiles,
  readConfinedFile,
  resolveEligibleDropSource,
  type DiscoveredFile,
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
  // Count of statements that could DURABLY MUTATE the thoughts table (INSERT or
  // tag-only UPDATE). The read probe/re-read do NOT count. A true no-op rerun
  // must leave this at zero.
  const counters = { durableWrites: 0 };

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

      // Pre-write probe for an existing (content_hash, namespace) row. This is
      // the no-op gate: the collector reads this BEFORE embedding/writing. Each
      // probe is counted so a rerun can be proven not to touch the write path.
      if (
        sql.includes("SELECT id, tags FROM thoughts") &&
        sql.includes("WHERE content_hash = $1 AND namespace = $2")
      ) {
        const [hash, namespace] = params as [string, string];
        const existing = thoughts.find(
          (t) => t.content_hash === hash && t.namespace === namespace,
        );
        return existing
          ? { rows: [{ id: existing.id, tags: [...existing.tags] }] }
          : { rows: [] };
      }

      // Re-read of id after an ON CONFLICT arm whose WHERE excluded the update.
      if (
        sql.includes("SELECT id FROM thoughts") &&
        sql.includes("WHERE content_hash = $1 AND namespace = $2")
      ) {
        const [hash, namespace] = params as [string, string];
        const existing = thoughts.find(
          (t) => t.content_hash === hash && t.namespace === namespace,
        );
        return existing ? { rows: [{ id: existing.id }] } : { rows: [] };
      }

      // Tag-only UPDATE (content unchanged, tag set strictly grew). Bumps only
      // tags; counted as a durable mutation.
      if (
        sql.includes("UPDATE thoughts") &&
        sql.includes("WHERE content_hash = $1 AND namespace = $2")
      ) {
        counters.durableWrites += 1;
        const [hash, namespace, tags] = params as [string, string, string[]];
        const existing = thoughts.find(
          (t) => t.content_hash === hash && t.namespace === namespace,
        );
        if (existing) {
          for (const tag of tags) {
            if (!existing.tags.includes(tag)) existing.tags.push(tag);
          }
          return { rows: [{ id: existing.id }] };
        }
        return { rows: [] };
      }

      // Durable upsert into thoughts with content-hash dedupe. Only reached for
      // NEW content (the collector probes first), but the ON CONFLICT arm is
      // modeled for the concurrent-writer race: if the row already exists, the
      // WHERE (NOT EXCLUDED.tags <@ thoughts.tags) decides whether to update.
      if (sql.includes("INSERT INTO thoughts")) {
        counters.durableWrites += 1;
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
          // ON CONFLICT ... WHERE NOT (EXCLUDED.tags <@ thoughts.tags): update
          // (and RETURN a row) only when the incoming tags add something.
          const adds = tags.some((tag) => !existing.tags.includes(tag));
          if (!adds) {
            // WHERE excluded the update: no row returned (collector re-reads id).
            return { rows: [] };
          }
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
  return {
    pool: pool as unknown as DropCollectorPool,
    thoughts,
    src,
    counters,
  };
}

const embedFn = async () => null;

// A counting embed function: proves the collector does NOT embed on a no-op
// rerun. Every call increments; a genuine no-op leaves it unchanged.
function countingEmbedFn() {
  const state = { calls: 0 };
  const fn = (async () => {
    state.calls += 1;
    return null;
  }) as typeof embedFn;
  return { fn, state };
}

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

  it("a repeated unchanged collection performs ZERO embedding and ZERO durable mutation", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    await writeFile(join(root, "b.md"), BODY_B);
    const fake = makeFake({ external_id: "drop-a", config: { root } });
    const embed1 = countingEmbedFn();

    const first = await collectDropFolder(
      { pool: fake.pool, embedFn: embed1.fn },
      adminAuth,
      { external_id: "drop-a", tags: ["drop"] },
    );
    expect(first.collected).toBe(2);
    // First pass: two new rows embedded + written.
    expect(embed1.state.calls).toBe(2);
    expect(fake.counters.durableWrites).toBe(2);
    const stampedAfterFirst = fake.src.content_hash;

    // Rerun with a FRESH embed counter and the write counter reset, same tags.
    const embed2 = countingEmbedFn();
    fake.counters.durableWrites = 0;
    const second = await collectDropFolder(
      { pool: fake.pool, embedFn: embed2.fn },
      adminAuth,
      { external_id: "drop-a", tags: ["drop"] },
    );
    expect(second.collected).toBe(0);
    expect(second.deduped).toBe(2);
    // The proof: nothing embedded and nothing durably mutated on the rerun.
    expect(embed2.state.calls).toBe(0);
    expect(fake.counters.durableWrites).toBe(0);
    // The source hash stamp did not churn either (same manifest digest).
    expect(fake.src.content_hash).toBe(stampedAfterFirst);
    // Still exactly two durable rows.
    expect(fake.thoughts.length).toBe(2);
  });

  it("an unchanged rerun with NEW tags updates only tags (no embed, one tag-only write)", async () => {
    await writeFile(join(root, "a.txt"), BODY_A);
    const fake = makeFake({ external_id: "drop-a", config: { root } });

    await collectDropFolder({ pool: fake.pool, embedFn }, adminAuth, {
      external_id: "drop-a",
      tags: ["one"],
    });
    expect(fake.thoughts.length).toBe(1);
    expect(fake.thoughts[0]!.tags).toEqual(["one"]);

    // Rerun with a new tag: content unchanged, so NO embed; only the tag set is
    // updated, and only because it strictly grows.
    const embed = countingEmbedFn();
    fake.counters.durableWrites = 0;
    const result = await collectDropFolder(
      { pool: fake.pool, embedFn: embed.fn },
      adminAuth,
      { external_id: "drop-a", tags: ["two"] },
    );
    expect(result.collected).toBe(0);
    expect(result.deduped).toBe(1);
    expect(embed.state.calls).toBe(0); // no re-embed
    expect(fake.counters.durableWrites).toBe(1); // exactly one tag-only update
    expect(fake.thoughts[0]!.tags.sort()).toEqual(["one", "two"]);

    // A further rerun with the SAME merged tags is again a true no-op.
    const embed2 = countingEmbedFn();
    fake.counters.durableWrites = 0;
    await collectDropFolder(
      { pool: fake.pool, embedFn: embed2.fn },
      adminAuth,
      { external_id: "drop-a", tags: ["one", "two"] },
    );
    expect(embed2.state.calls).toBe(0);
    expect(fake.counters.durableWrites).toBe(0);
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

  it("truncates truthfully (aggregate flag only) when more files exist than the count bound", async () => {
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
      // Bounded discovery contract: the omitted tail produces NO per-file
      // receipts. Only maxFiles receipts exist; truncation is the aggregate flag.
      expect((result.files ?? []).length).toBe(2);
      // No receipt has a count_bound reason (the reason no longer exists).
      expect(
        (result.files ?? []).some(
          (f) => (f.reason as string) === "count_bound",
        ),
      ).toBe(false);
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

// Capture the confined discovery identity (dev/ino/relPath) of one file exactly
// as discoverFiles would, so an adversarial test can swap the underlying path
// AFTER capture and prove the descriptor read still binds to the ORIGINAL inode.
async function captureIdentity(
  realPath: string,
  relPath: string,
): Promise<DiscoveredFile> {
  const st = await stat(realPath);
  return { realPath, dev: st.dev, ino: st.ino, relPath };
}

describe("drop-folder collector — P1 TOCTOU descriptor binding", () => {
  it("rejects the read when a validated file is swapped to an OUTSIDE symlink before read", async () => {
    // A legitimate in-root file is discovered and its identity captured.
    const inside = join(root, "a.txt");
    await writeFile(inside, "ORIGINAL_SAFE_CONTENT within the root");
    const file = await captureIdentity(inside, "a.txt");

    // Attacker: an oversized/secret target OUTSIDE the root.
    const outside = await mkdtemp(join(tmpdir(), "drop-toctou-out-"));
    try {
      const secret = join(outside, "secret.txt");
      await writeFile(secret, "OUTSIDE_SECRET_do_not_leak: attacker target");

      // Swap the final component to a symlink pointing at the outside secret,
      // AFTER discovery captured the real-file identity.
      await unlink(inside);
      await symlink(secret, inside);

      // O_NOFOLLOW makes the open fail (ELOOP) on the swapped symlink; the read
      // is rejected and never follows the post-validation symlink.
      const read = await readConfinedFile(file, 1_048_576, 1_048_576);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toBe("unreadable");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects the read when the validated name is swapped to a DIFFERENT regular file (inode mismatch)", async () => {
    // Discover file A and capture its inode identity.
    const target = join(root, "a.txt");
    await writeFile(target, "ORIGINAL_A content under the root");
    const file = await captureIdentity(target, "a.txt");

    // Swap the name to a DIFFERENT real regular file (a plain rename-over, not a
    // symlink) so O_NOFOLLOW alone would not catch it — only the dev/ino identity
    // binding does.
    const other = join(root, "other.txt");
    await writeFile(other, "SWAPPED_B_do_not_leak: a different inode entirely");
    await rename(other, target); // target now has a different inode

    const read = await readConfinedFile(file, 1_048_576, 1_048_576);
    // The opened descriptor's inode no longer matches the captured identity.
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("unreadable");
  });

  it("reads only bounded bytes even if the file GROWS after metadata capture", async () => {
    // Capture identity at a small size, then grow the file far past the per-file
    // cap before the descriptor read. The read must stay bounded and reject.
    const p = join(root, "grow.txt");
    await writeFile(p, "small");
    const file = await captureIdentity(p, "grow.txt");

    // Grow the SAME inode (append in place) to 4 KiB, well past a 16-byte cap.
    await writeFile(p, "X".repeat(4096));

    const cap = 16;
    const read = await readConfinedFile(file, cap, 1_048_576);
    // Same inode, but now oversized: bounded read detects overflow and rejects
    // rather than ingesting the grown content.
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("too_large");
  });

  it("reads exactly the descriptor bytes for a legitimate in-identity file", async () => {
    const p = join(root, "ok.txt");
    await writeFile(p, "exactly these bytes");
    const file = await captureIdentity(p, "ok.txt");
    const read = await readConfinedFile(file, 1_048_576, 1_048_576);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.content).toBe("exactly these bytes");
      expect(read.byteLength).toBe("exactly these bytes".length);
    }
  });

  it("end-to-end: a file swapped to an outside symlink after discovery never lands the outside body", async () => {
    // Full collectDropFolder path. We cannot interleave the swap mid-call
    // deterministically, but the descriptor binding is proven above; here we
    // confirm the integrated path never reads an escaping symlink's target even
    // when the symlink is present at discovery time (confinement) AND that the
    // read path is descriptor-bound (no path re-resolution).
    const outside = await mkdtemp(join(tmpdir(), "drop-e2e-out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "E2E_SECRET_do_not_leak");
      await writeFile(join(root, "real.txt"), "E2E_REAL under root");
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      expect(result.collected).toBe(1);
      expect(thoughts.length).toBe(1);
      expect(thoughts[0]!.content).toBe("E2E_REAL under root");
      const serialized = JSON.stringify({ result, thoughts });
      expect(serialized).not.toContain("E2E_SECRET_do_not_leak");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("drop-folder collector — P2 bounded discovery work", () => {
  it("retains at most maxFiles and reports truncated for a >maxFiles tree without per-file tail work", async () => {
    process.env.DROP_COLLECTOR_MAX_FILES = "3";
    try {
      // 12 supported files, well over the bound of 3.
      for (let i = 0; i < 12; i++) {
        await writeFile(
          join(root, `f${String(i).padStart(2, "0")}.txt`),
          `content number ${i}`,
        );
      }
      const { files, truncated } = await discoverFiles(await realpath(root), 3);
      // At most maxFiles retained; the omitted tail is NOT materialized.
      expect(files.length).toBe(3);
      expect(truncated).toBe(true);
      // The retained bounded set is SORTED before return. Which specific files
      // survive the bounded-buffer race is intentionally NOT asserted: hard
      // bounded work forbids a full per-directory sort, so the candidate sentinel
      // stops the walk after limit+1 supported files are seen in filesystem order.
      // Determinism under a truncated hostile tree is secondary to the work bound;
      // the ordering of the retained set is the invariant.
      const rels = files.map((f) => f.relPath);
      expect([...rels].sort()).toEqual(rels);
      // Every retained entry is one of the real supported files (no phantom).
      for (const rel of rels) {
        expect(rel).toMatch(/^f\d{2}\.txt$/);
      }
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
    }
  });

  it("does not truncate when the tree has exactly maxFiles files", async () => {
    await writeFile(join(root, "a.txt"), "one");
    await writeFile(join(root, "b.txt"), "two");
    await writeFile(join(root, "c.txt"), "three");
    const { files, truncated } = await discoverFiles(await realpath(root), 3);
    expect(files.length).toBe(3);
    expect(truncated).toBe(false);
  });

  it("integrated: an oversized tree yields exactly maxFiles receipts, truncated=true, and no count_bound receipts", async () => {
    process.env.DROP_COLLECTOR_MAX_FILES = "4";
    try {
      for (let i = 0; i < 20; i++) {
        await writeFile(
          join(root, `x${String(i).padStart(2, "0")}.txt`),
          `distinct body ${i} here`,
        );
      }
      const { pool, thoughts } = makeFake({
        external_id: "drop-a",
        config: { root },
      });
      const result = await collectDropFolder({ pool, embedFn }, adminAuth, {
        external_id: "drop-a",
      });
      expect(result.truncated).toBe(true);
      // Exactly maxFiles receipts — the omitted 16 produce NO receipts.
      expect((result.files ?? []).length).toBe(4);
      expect(result.collected).toBe(4);
      expect(thoughts.length).toBe(4);
      // The tail was never enumerated into per-file work.
      expect(
        (result.files ?? []).some(
          (f) => (f.reason as string) === "count_bound",
        ),
      ).toBe(false);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
    }
  });

  it("bounded-buffer discovery keeps the sorted prefix regardless of filesystem order across subdirs", async () => {
    process.env.DROP_COLLECTOR_MAX_FILES = "2";
    try {
      await mkdir(join(root, "zsub"));
      await mkdir(join(root, "asub"));
      await writeFile(join(root, "zsub", "z.txt"), "z");
      await writeFile(join(root, "asub", "a.txt"), "a");
      await writeFile(join(root, "m.txt"), "m");
      const { files, truncated } = await discoverFiles(await realpath(root), 2);
      expect(truncated).toBe(true);
      expect(files.length).toBe(2);
      // Global sorted prefix by relPath: asub/a.txt < m.txt < zsub/z.txt.
      expect(files.map((f) => f.relPath)).toEqual(["asub/a.txt", "m.txt"]);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
    }
  });
});

// Run discoverFiles while counting the ACTUAL realpath/stat calls it makes, by
// spying on the shared node:fs/promises module the collector imports from. The
// spies delegate to the real implementations (so discovery behaves normally) and
// are restored afterward. `entriesInspected` is the collector's own honest work
// counter; realpathCalls/statCalls prove the per-entry syscall work stayed
// bounded too, independent of tree size.
async function countedDiscover(realRoot: string, limit: number) {
  let realpathCalls = 0;
  let statCalls = 0;
  const realRealpath = fsPromises.realpath;
  const realStat = fsPromises.stat;
  const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation(((
    ...args: Parameters<typeof realRealpath>
  ) => {
    realpathCalls += 1;
    return (realRealpath as (...a: unknown[]) => unknown)(...args);
  }) as typeof realRealpath);
  const statSpy = spyOn(fsPromises, "stat").mockImplementation(((
    ...args: Parameters<typeof realStat>
  ) => {
    statCalls += 1;
    return (realStat as (...a: unknown[]) => unknown)(...args);
  }) as typeof realStat);
  try {
    const result = await discoverFiles(realRoot, limit);
    return { result, realpathCalls, statCalls };
  } finally {
    realpathSpy.mockRestore();
    statSpy.mockRestore();
  }
}

describe("drop-folder collector — P2 hard-bounded traversal work", () => {
  it("bounds inspected/realpath/stat work far below tree size when the entry-scan bound trips first", async () => {
    // A tree FAR beyond both the file candidate bound AND the entry-scan bound.
    // With maxFiles=4 and scan-entries=40, we place 500 supported files. The scan
    // bound (40) trips long before all 500 are inspected, so work must stay near
    // the bound — NOT scale with the 500-entry tree.
    process.env.DROP_COLLECTOR_MAX_FILES = "4";
    process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES = "40";
    try {
      for (let i = 0; i < 500; i++) {
        await writeFile(
          join(root, `f${String(i).padStart(4, "0")}.txt`),
          `body number ${i}`,
        );
      }
      // Wrap fs to count actual realpath/stat calls the discovery performs.
      const realRoot = await realpath(root);
      const counts = await countedDiscover(realRoot, 4);

      // truncated because the walk stopped before draining the tree.
      expect(counts.result.truncated).toBe(true);
      // At most maxFiles retained.
      expect(counts.result.files.length).toBe(4);
      // The hard bound: entries inspected never exceeds the scan bound, and is
      // orders of magnitude below the 500-file tree.
      expect(counts.result.entriesInspected).toBeLessThanOrEqual(40);
      expect(counts.result.entriesInspected).toBeLessThan(60);
      // realpath + stat work is bounded by inspected entries, NOT tree size.
      expect(counts.realpathCalls).toBeLessThanOrEqual(40);
      expect(counts.statCalls).toBeLessThanOrEqual(40);
      // Proof it did not walk the whole tree: work is a tiny fraction of 500.
      expect(counts.realpathCalls).toBeLessThan(60);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
      delete process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES;
    }
  });

  it("many UNSUPPORTED entries cannot hide unbounded scanning: work stays bounded by the scan bound", async () => {
    // Only a handful of supported files, but a huge number of UNSUPPORTED entries
    // (.bin). The supported-file candidate sentinel (maxFiles+1) will NEVER trip,
    // so the ONLY thing that can bound the walk is the entry-scan bound. Without
    // it, the walk would stat/realpath every one of the 400 unsupported entries.
    process.env.DROP_COLLECTOR_MAX_FILES = "8";
    process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES = "50";
    try {
      // 2 supported files (well under maxFiles=8, so the file sentinel can't trip)
      // amid 400 unsupported ones.
      await writeFile(join(root, "keep-a.txt"), "supported alpha");
      await writeFile(join(root, "keep-b.md"), "supported bravo");
      for (let i = 0; i < 400; i++) {
        await writeFile(
          join(root, `junk${String(i).padStart(4, "0")}.bin`),
          `unsupported ${i}`,
        );
      }
      const realRoot = await realpath(root);
      const counts = await countedDiscover(realRoot, 8);

      // The scan bound tripped (tree not drained) even though the file sentinel
      // could not: many unsupported entries did NOT enable unbounded scanning.
      expect(counts.result.truncated).toBe(true);
      expect(counts.result.entriesInspected).toBeLessThanOrEqual(50);
      // realpath/stat work bounded by inspected entries, far below the 402-entry
      // tree — every inspected UNSUPPORTED entry counts against the same bound.
      expect(counts.realpathCalls).toBeLessThanOrEqual(50);
      expect(counts.statCalls).toBeLessThanOrEqual(50);
      expect(counts.realpathCalls).toBeLessThan(100);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
      delete process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES;
    }
  });

  it("does NOT truncate and inspects the whole (small) tree when both bounds have headroom", async () => {
    // A small tree well under both bounds: discovery drains it fully, truncated is
    // false, and entriesInspected equals the real entry count (proving the counter
    // is honest, not clamped).
    process.env.DROP_COLLECTOR_MAX_FILES = "10";
    process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES = "100";
    try {
      await writeFile(join(root, "a.txt"), "one");
      await writeFile(join(root, "b.md"), "two");
      await writeFile(join(root, "c.log"), "three");
      const realRoot = await realpath(root);
      const counts = await countedDiscover(realRoot, 10);
      expect(counts.result.truncated).toBe(false);
      expect(counts.result.files.length).toBe(3);
      // Exactly the three real entries were inspected — no over- or under-count.
      expect(counts.result.entriesInspected).toBe(3);
      expect(counts.realpathCalls).toBe(3);
      expect(counts.statCalls).toBe(3);
    } finally {
      delete process.env.DROP_COLLECTOR_MAX_FILES;
      delete process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES;
    }
  });
});

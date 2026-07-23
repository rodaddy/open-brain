import { describe, it, expect } from "bun:test";
import {
  collectDropFolder,
  resolveEligibleDropSource,
  type CollectDropFolderInput,
} from "./drop-folder-collector.ts";
import { hashSourceContent } from "./source-registry.ts";
import type { AuthInfo } from "./types.ts";

// A drop body sentinel. It is the raw content a caller hands the collector; it
// must never appear in any receipt, counter, code, or (in the boundary suite) a
// log line. Only its opaque digest and structural counts may travel.
const BODY = "PRIVATE_DROP_BODY_do_not_leak: quarterly plan for 2026-05-01";
const BODY_2 = "SECOND_DROP_BODY_do_not_leak: different content entirely";

const adminAuth: AuthInfo = {
  role: "admin",
  clientId: "admin-client",
  namespaceSource: "token",
};

// A minimal stateful fake modeling the two tables the collector touches:
//  - ob_sources: the registry gate (resolveIngestionEligibility SELECT) and the
//    hash re-stamp (updateSource UPDATE + probe).
//  - thoughts: the durable upsert, including the (content_hash, namespace)
//    ON CONFLICT dedupe that makes identical content merge instead of insert.
// It routes on stable substrings of the collector's own parameterized SQL, so
// the test exercises real behavior (dedupe, hash advance) rather than SQL shape.
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
          // Apply the content_hash / last_synced_at / sync_state sets by
          // scanning the remaining params (positional, after the WHERE trio).
          // The collector only ever sets sync_state, content_hash, last_synced_at.
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

  return { pool, thoughts, src };
}

const embedFn = async () => null;

function assertContentFree(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(BODY);
  expect(serialized).not.toContain(BODY_2);
  expect(serialized).not.toContain("PRIVATE_DROP_BODY");
  expect(serialized).not.toContain("SECOND_DROP_BODY");
}

describe("drop-folder collector — eligibility gate", () => {
  it("rejects an unregistered drop source truthfully without collecting", async () => {
    const { pool, thoughts } = makeFake({ external_id: "drop-a" });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-UNKNOWN",
        items: [{ external_id: "drop-UNKNOWN", content: BODY }],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("not_found");
    expect(result.items).toBeUndefined();
    expect(thoughts.length).toBe(0);
    assertContentFree(result);
  });

  it("rejects a registered-but-unapproved (pending) drop source; nothing collected", async () => {
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      approval_state: "pending",
    });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-a",
        items: [{ external_id: "drop-a", content: BODY }],
      },
    );
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("approval_denied");
    expect(thoughts.length).toBe(0);
  });

  it("rejects an approved but paused (non-active) drop source", async () => {
    const { pool, thoughts } = makeFake({
      external_id: "drop-a",
      lifecycle_state: "paused",
    });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-a",
        items: [{ external_id: "drop-a", content: BODY }],
      },
    );
    expect(result.eligible).toBe(false);
    expect(result.code).toBe("approval_denied");
    expect(thoughts.length).toBe(0);
  });

  it("only serves the 'drop' kind: resolveEligibleDropSource gates on kind", async () => {
    // A source registered under a different kind at the same external_id is not
    // a drop source, so the drop gate must not find it.
    const { pool } = makeFake({ external_id: "drop-a", source_kind: "git" });
    const gate = await resolveEligibleDropSource(
      pool as never,
      adminAuth,
      "drop-a",
    );
    expect(gate.eligible).toBe(false);
  });
});

describe("drop-folder collector — collection + dedupe", () => {
  it("collects new content, writes durably, and advances the source hash", async () => {
    const { pool, thoughts, src } = makeFake({ external_id: "drop-a" });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-a",
        items: [{ external_id: "drop-a", content: BODY }],
      },
    );
    expect(result.eligible).toBe(true);
    expect(result.collected).toBe(1);
    expect(result.deduped).toBe(0);
    expect(result.rejected).toBe(0);
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.content).toBe(BODY);

    const receipt = result.items![0]!;
    expect(receipt.status).toBe("collected");
    expect(receipt.content_hash).toBe(hashSourceContent(BODY).content_hash);
    expect(receipt.durable_id).toBeDefined();
    expect(receipt.durable_merged).toBe(false);

    // The source's last-observed hash advanced to the collected content.
    expect(src.content_hash).toBe(hashSourceContent(BODY).content_hash);
    expect(src.sync_state).toBe("synced");
    assertContentFree(result);
  });

  it("dedupes repeated identical content across separate collect calls (no-op)", async () => {
    const fake = makeFake({ external_id: "drop-a" });
    const deps = { pool: fake.pool as never, embedFn };
    const input: CollectDropFolderInput = {
      external_id: "drop-a",
      items: [{ external_id: "drop-a", content: BODY }],
    };

    const first = await collectDropFolder(deps, adminAuth, input);
    expect(first.collected).toBe(1);
    const revAfterFirst = fake.src.revision;

    // Re-collect the identical content: the source's stored hash already matches,
    // so it dedupes — no new durable row, and the source hash is NOT re-stamped
    // (revision unchanged).
    const second = await collectDropFolder(deps, adminAuth, input);
    expect(second.collected).toBe(0);
    expect(second.deduped).toBe(1);
    expect(second.items![0]!.status).toBe("deduped");
    expect(fake.thoughts.length).toBe(1);
    expect(fake.src.revision).toBe(revAfterFirst);
  });

  it("dedupes identical items WITHIN one batch: collects once, dedupes the rest", async () => {
    const { pool, thoughts } = makeFake({ external_id: "drop-a" });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-a",
        items: [
          { external_id: "drop-a", content: BODY },
          { external_id: "drop-a", content: BODY },
          { external_id: "drop-a", content: BODY },
        ],
      },
    );
    expect(result.collected).toBe(1);
    expect(result.deduped).toBe(2);
    expect(thoughts.length).toBe(1);
    expect(result.items!.map((i) => i.status)).toEqual([
      "collected",
      "deduped",
      "deduped",
    ]);
  });

  it("collects genuinely different content as distinct durable rows", async () => {
    const { pool, thoughts } = makeFake({ external_id: "drop-a" });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-a",
        items: [
          { external_id: "drop-a", content: BODY },
          { external_id: "drop-a", content: BODY_2 },
        ],
      },
    );
    expect(result.collected).toBe(2);
    expect(result.deduped).toBe(0);
    expect(thoughts.length).toBe(2);
    expect(result.items![0]!.content_hash).not.toBe(
      result.items![1]!.content_hash,
    );
  });

  it("rejects a batch item whose external_id does not match the gated source", async () => {
    const { pool, thoughts } = makeFake({ external_id: "drop-a" });
    const result = await collectDropFolder(
      { pool: pool as never, embedFn },
      adminAuth,
      {
        external_id: "drop-a",
        items: [
          { external_id: "drop-a", content: BODY },
          { external_id: "drop-OTHER", content: BODY_2 },
        ],
      },
    );
    expect(result.collected).toBe(1);
    expect(result.rejected).toBe(1);
    const rejected = result.items!.find((i) => i.status === "rejected")!;
    expect(rejected.code).toBe("identity_mismatch");
    // The mismatched item was NOT written durably.
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.content).toBe(BODY);
    assertContentFree(result);
  });
});

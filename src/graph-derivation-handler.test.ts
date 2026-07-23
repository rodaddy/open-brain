import { describe, expect, it } from "bun:test";
import {
  GRAPH_DERIVATION_JOB_KIND,
  GRAPH_DERIVATION_JOB_VERSION,
  GraphDerivationTerminalError,
  SOURCE_ANCHOR_ENTITY_TYPE,
  buildGraphDerivationEnqueue,
  enqueueGraphDerivationJobs,
  graphDerivationPayloadSchema,
  makeGraphDerivationHandler,
  selectSourcesNeedingDerivation,
  type GraphDerivationEnqueuePort,
  type GraphDerivationPayload,
  type SourceNeedingDerivation,
} from "./graph-derivation-handler.ts";
import {
  type EnqueueMaintenanceJob,
  type MaintenanceJob,
} from "./maintenance-queue.ts";
import { logger } from "./logger.ts";
import type { AuthInfo } from "./types.ts";

/**
 * Capture every field the handler hands the logger during `fn`, then restore
 * the real logger. Backs the content-free sentinel: a successful handler run
 * must emit only the stable source_kind category, the derivation status, and
 * structural counts — never a namespace value, a content/derivation hash, a
 * source id, a title, or an external id.
 */
async function captureLoggerFields(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>[]> {
  const captured: Record<string, unknown>[] = [];
  const original = {
    info: logger.info,
    debug: logger.debug,
    warn: logger.warn,
    error: logger.error,
  };
  const record = (extra?: Record<string, unknown>) => {
    if (extra) captured.push(extra);
  };
  logger.info = (_m, extra) => record(extra);
  logger.debug = (_m, extra) => record(extra);
  logger.warn = (_m, extra) => record(extra);
  logger.error = (_m, extra) => record(extra);
  try {
    await fn();
  } finally {
    logger.info = original.info;
    logger.debug = original.debug;
    logger.warn = original.warn;
    logger.error = original.error;
  }
  return captured;
}

// ---------------------------------------------------------------------------
// A small in-memory pool that models the two tables the integration reads:
// ob_sources (the selection + snapshot-guard surface) and ob_entities (the
// anchor the derivation stamps / the selection join reads). It is deliberately
// simple: enough to exercise the exact WHERE/JOIN semantics the selection and
// snapshot guard rely on, plus record calls for shape assertions. The graph
// writes themselves are covered by graph-derivation.test.ts against a richer
// fake and the live-Postgres suite; here we assert the INTEGRATION contract.
// ---------------------------------------------------------------------------

interface FakeSource {
  id: string;
  namespace: string;
  source_kind: string;
  external_id: string;
  title: string | null;
  approval_state: string;
  lifecycle_state: string;
  content_hash: string | null;
  revision: number;
  updated_at: string;
}

interface FakeAnchor {
  namespace: string;
  entity_type: string;
  canonical_id: string;
  content_hash: string | null;
  derivation_hash: string | null;
  archived_at: string | null;
}

class FakeSourcePool {
  sources: FakeSource[] = [];
  anchors: FakeAnchor[] = [];
  calls: Array<{ sql: string; params: unknown[] }> = [];
  private seq = 0;

  private nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any = (async (sql: string, params: unknown[] = []) => {
    this.calls.push({ sql, params });
    const text = String(sql);

    // --- selection sweep (SELECT ... FROM ob_sources s LEFT JOIN ob_entities anchor)
    if (text.includes("LEFT JOIN ob_entities anchor")) {
      const anchorType = params[0] as string;
      // Optional namespace predicate: present iff the SQL binds a text[] param.
      const nsList = text.includes("s.namespace = ANY(")
        ? (params[1] as string[])
        : undefined;
      const rows = this.sources
        .filter(
          (s) =>
            s.approval_state === "approved" &&
            s.lifecycle_state === "active" &&
            s.content_hash !== null &&
            /^[0-9a-f]{64}$/.test(s.content_hash) &&
            (nsList === undefined || nsList.includes(s.namespace)),
        )
        .map((s) => {
          const anchor = this.anchors.find(
            (a) =>
              a.namespace === s.namespace &&
              a.entity_type === anchorType &&
              a.canonical_id === `${anchorType}:${s.id}` &&
              a.archived_at === null,
          );
          return {
            ...s,
            derived_content_hash: anchor ? anchor.content_hash : null,
            _anchorMissing: anchor === undefined,
          };
        })
        // WHERE: anchor missing OR anchor hash IS DISTINCT FROM s.content_hash
        .filter(
          (r) => r._anchorMissing || r.derived_content_hash !== r.content_hash,
        )
        .sort((a, b) =>
          a.updated_at < b.updated_at
            ? -1
            : a.updated_at > b.updated_at
              ? 1
              : 0,
        )
        .map((r) => ({
          id: r.id,
          namespace: r.namespace,
          source_kind: r.source_kind,
          external_id: r.external_id,
          content_hash: r.content_hash,
          revision: r.revision,
          derived_content_hash: r.derived_content_hash,
        }));
      return { rows };
    }

    // --- snapshot guard (SELECT title FROM ob_sources WHERE id=..revision=..)
    if (text.includes("SELECT title") && text.includes("FROM ob_sources")) {
      const [id, ns, kind, externalId, hash, revision] = params as [
        string,
        string,
        string,
        string,
        string,
        number,
      ];
      const match = this.sources.find(
        (s) =>
          s.id === id &&
          s.namespace === ns &&
          s.source_kind === kind &&
          s.external_id === externalId &&
          s.content_hash === hash &&
          s.revision === revision &&
          s.approval_state === "approved" &&
          s.lifecycle_state === "active",
      );
      return { rows: match ? [{ title: match.title }] : [] };
    }

    // --- graph derivation primitive queries (prior-hash read + upserts).
    // Model just enough: the prior-hash SELECT returns the anchor's stamped
    // hash; entity/link INSERTs return a fresh-namespace row and stamp the
    // anchor. This lets the handler exercise the real primitive end to end.
    if (text.includes("SELECT metadata ->> 'derivation_hash'")) {
      const [ns, type, canonical] = params as [string, string, string];
      const anchor = this.anchors.find(
        (a) =>
          a.namespace === ns &&
          a.entity_type === type &&
          a.canonical_id === canonical &&
          a.archived_at === null,
      );
      if (!anchor) return { rows: [] };
      // The real SELECT reads both hash keys; the fake tracks content_hash and
      // the derivation_hash it stamped, so an unchanged rerun short-circuits.
      return {
        rows: [
          {
            derivation_hash: anchor.derivation_hash ?? null,
            content_hash: anchor.content_hash ?? null,
          },
        ],
      };
    }
    // Content-hash refresh on the unchanged path (metadata || $4::jsonb).
    if (
      text.includes("UPDATE ob_entities") &&
      text.includes("metadata || $4::jsonb")
    ) {
      const [ns, type, canonical, patch] = params as [
        string,
        string,
        string,
        string,
      ];
      const anchor = this.anchors.find(
        (a) =>
          a.namespace === ns &&
          a.entity_type === type &&
          a.canonical_id === canonical &&
          a.archived_at === null,
      );
      if (anchor) {
        const parsed = JSON.parse(patch) as { content_hash?: string };
        if (parsed.content_hash !== undefined) {
          anchor.content_hash = parsed.content_hash;
        }
      }
      return { rows: [] };
    }
    if (text.includes("INSERT INTO ob_entities")) {
      const [type, , canonical, ns, meta] = params as [
        string,
        string,
        string,
        string,
        string?,
      ];
      // Anchor upsert carries a metadata param ($5::jsonb); derived terms don't.
      if (text.includes("$5::jsonb") && typeof meta === "string") {
        const parsedMeta = JSON.parse(meta) as {
          derivation_hash?: string;
          content_hash?: string;
        };
        const existing = this.anchors.find(
          (a) =>
            a.namespace === ns &&
            a.entity_type === type &&
            a.canonical_id === canonical,
        );
        // The primitive stamps content_hash and derivation_hash directly in the
        // $5::jsonb metadata bind — read them straight from the parsed param.
        if (existing) {
          existing.content_hash =
            parsedMeta.content_hash ?? existing.content_hash;
          existing.derivation_hash =
            parsedMeta.derivation_hash ?? existing.derivation_hash;
          return {
            rows: [
              { id: this.anchorId(existing), is_new: false, namespace: ns },
            ],
          };
        }
        const anchor: FakeAnchor = {
          namespace: ns,
          entity_type: type,
          canonical_id: canonical,
          content_hash: parsedMeta.content_hash ?? null,
          derivation_hash: parsedMeta.derivation_hash ?? null,
          archived_at: null,
        };
        this.anchors.push(anchor);
        return {
          rows: [{ id: this.anchorId(anchor), is_new: true, namespace: ns }],
        };
      }
      return { rows: [{ id: this.nextId(), is_new: true, namespace: ns }] };
    }
    if (text.includes("INSERT INTO ob_links")) {
      const ns = params[3] as string;
      return { rows: [{ id: this.nextId(), is_new: true, namespace: ns }] };
    }

    throw new Error(`unexpected sql: ${text.slice(0, 60)}`);
  }) as any;

  private anchorIds = new Map<FakeAnchor, string>();
  private anchorId(anchor: FakeAnchor): string {
    let id = this.anchorIds.get(anchor);
    if (!id) {
      id = this.nextId();
      this.anchorIds.set(anchor, id);
    }
    return id;
  }
}

const auth: AuthInfo = {
  role: "admin",
  clientId: "maintenance",
  namespaceSource: "token",
};

function makeSource(over: Partial<FakeSource> = {}): FakeSource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    namespace: "team-kb",
    source_kind: "git",
    external_id: "https://example.invalid/repo.git",
    title: "release plan",
    approval_state: "approved",
    lifecycle_state: "active",
    content_hash: "a".repeat(64),
    revision: 3,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function jobFor(
  payload: GraphDerivationPayload,
  namespace: string | null,
): MaintenanceJob {
  return {
    id: "job-1",
    kind: GRAPH_DERIVATION_JOB_KIND,
    version: GRAPH_DERIVATION_JOB_VERSION,
    payload: payload as unknown as Record<string, unknown>,
    idempotencyKey: "k",
    state: "running",
    runAfter: new Date("2026-07-22T12:00:00.000Z"),
    leaseToken: "00000000-0000-4000-8000-000000000001",
    leaseUntil: new Date("2026-07-22T12:00:30.000Z"),
    attempts: 1,
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 4_000,
    lastErrorCategory: null,
    terminalAt: null,
    deadLetteredAt: null,
    namespace,
    provenance: null,
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
    updatedAt: new Date("2026-07-22T12:00:00.000Z"),
  };
}

function payloadFor(
  source: FakeSource,
  over: Partial<GraphDerivationPayload> = {},
): GraphDerivationPayload {
  return {
    source_id: source.id,
    source_kind: source.source_kind as GraphDerivationPayload["source_kind"],
    external_id: source.external_id,
    content_hash: source.content_hash as string,
    revision: source.revision,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// selection: new / unchanged / changed by content hash
// ---------------------------------------------------------------------------

describe("selectSourcesNeedingDerivation", () => {
  it("new: an approved+active source with no anchor is selected", async () => {
    const pool = new FakeSourcePool();
    pool.sources.push(makeSource());
    const rows = await selectSourcesNeedingDerivation(pool, ["team-kb"]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.derived_content_hash).toBeNull();
    expect(rows[0]!.content_hash).toBe("a".repeat(64));
  });

  it("unchanged: an anchor already derived for this hash is NOT selected", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource();
    pool.sources.push(s);
    pool.anchors.push({
      namespace: s.namespace,
      entity_type: SOURCE_ANCHOR_ENTITY_TYPE,
      canonical_id: `${SOURCE_ANCHOR_ENTITY_TYPE}:${s.id}`,
      content_hash: s.content_hash,
      derivation_hash: "deadbeef",
      archived_at: null,
    });
    const rows = await selectSourcesNeedingDerivation(pool, ["team-kb"]);
    expect(rows.length).toBe(0);
  });

  it("changed: an anchor derived for a DIFFERENT hash is selected", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ content_hash: "b".repeat(64) });
    pool.sources.push(s);
    pool.anchors.push({
      namespace: s.namespace,
      entity_type: SOURCE_ANCHOR_ENTITY_TYPE,
      canonical_id: `${SOURCE_ANCHOR_ENTITY_TYPE}:${s.id}`,
      content_hash: "a".repeat(64),
      derivation_hash: "deadbeef",
      archived_at: null,
    });
    const rows = await selectSourcesNeedingDerivation(pool, ["team-kb"]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.derived_content_hash).toBe("a".repeat(64));
  });

  it("skips pending/retired sources and sources without a well-formed hash", async () => {
    const pool = new FakeSourcePool();
    pool.sources.push(
      makeSource({
        id: "22222222-2222-4222-8222-222222222222",
        approval_state: "pending",
      }),
      makeSource({
        id: "33333333-3333-4333-8333-333333333333",
        lifecycle_state: "retired",
      }),
      makeSource({
        id: "44444444-4444-4444-8444-444444444444",
        content_hash: null,
      }),
      makeSource({
        id: "55555555-5555-4555-8555-555555555555",
        content_hash: "not-a-hash",
      }),
    );
    const rows = await selectSourcesNeedingDerivation(pool, ["team-kb"]);
    expect(rows.length).toBe(0);
  });

  it("cross-namespace negative: the writable-namespace predicate is bound as a param", async () => {
    const pool = new FakeSourcePool();
    pool.sources.push(makeSource({ namespace: "team-kb" }));
    // A caller writable only in a foreign namespace selects nothing.
    const rows = await selectSourcesNeedingDerivation(pool, ["other-team"]);
    expect(rows.length).toBe(0);
    // The predicate is a bound text[] param, never interpolated.
    const call = pool.calls.at(-1)!;
    expect(call.sql).toContain("s.namespace = ANY(");
    expect(call.params).toContainEqual(["other-team"]);
  });

  it("bounds the limit to the hard cap", async () => {
    const pool = new FakeSourcePool();
    await selectSourcesNeedingDerivation(pool, undefined, 10_000);
    const call = pool.calls.at(-1)!;
    // Limit is a bound param (last param); never interpolated as a literal.
    expect(call.params.at(-1)).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// enqueue: idempotency key binds source id + content hash
// ---------------------------------------------------------------------------

describe("buildGraphDerivationEnqueue", () => {
  const source: SourceNeedingDerivation = {
    id: "11111111-1111-4111-8111-111111111111",
    namespace: "team-kb",
    source_kind: "git",
    external_id: "repo",
    content_hash: "a".repeat(64),
    revision: 2,
    derived_content_hash: null,
  };

  it("binds kind, version, namespace, and a content-hash idempotency key", () => {
    const e = buildGraphDerivationEnqueue(source);
    expect(e.kind).toBe(GRAPH_DERIVATION_JOB_KIND);
    expect(e.version).toBe(GRAPH_DERIVATION_JOB_VERSION);
    expect(e.scope?.namespace).toBe("team-kb");
    expect(e.idempotencyKey).toBe(
      `${GRAPH_DERIVATION_JOB_KIND}:${source.id}:${"a".repeat(64)}`,
    );
    // Payload validates against the strict schema and is content-free.
    const parsed = graphDerivationPayloadSchema.safeParse(e.payload);
    expect(parsed.success).toBe(true);
  });

  it("a changed hash yields a DIFFERENT idempotency key (fresh job)", () => {
    const a = buildGraphDerivationEnqueue(source);
    const b = buildGraphDerivationEnqueue({
      ...source,
      content_hash: "b".repeat(64),
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("carries already-extracted metadata, dropping empty arrays", () => {
    const e = buildGraphDerivationEnqueue(source, {
      topics: ["Migrations"],
      people: [],
    });
    const parsed = graphDerivationPayloadSchema.parse(e.payload);
    expect(parsed.metadata?.topics).toEqual(["Migrations"]);
    expect(parsed.metadata?.people).toBeUndefined();
  });
});

describe("enqueueGraphDerivationJobs", () => {
  it("selects and enqueues one bounded job per source, resolving metadata outside the queue", async () => {
    const pool = new FakeSourcePool();
    pool.sources.push(
      makeSource({ id: "11111111-1111-4111-8111-111111111111" }),
      makeSource({
        id: "22222222-2222-4222-8222-222222222222",
        updated_at: "2026-07-02T00:00:00.000Z",
      }),
    );
    const enqueued: EnqueueMaintenanceJob[] = [];
    const queue: GraphDerivationEnqueuePort = {
      enqueue: async (input) => {
        enqueued.push(input);
        return { id: `mj-${enqueued.length}` } as unknown as MaintenanceJob;
      },
    };
    let resolveCalls = 0;
    const jobs = await enqueueGraphDerivationJobs(pool, queue, ["team-kb"], {
      resolveMetadata: (s) => {
        resolveCalls += 1;
        return { topics: [`topic-${s.id.slice(0, 8)}`], people: [] };
      },
    });
    expect(jobs.length).toBe(2);
    expect(enqueued.length).toBe(2);
    expect(resolveCalls).toBe(2);
    expect(enqueued[0]!.kind).toBe(GRAPH_DERIVATION_JOB_KIND);
    expect(enqueued[0]!.scope?.namespace).toBe("team-kb");
  });
});

// ---------------------------------------------------------------------------
// handler: registration/call shape, snapshot guard, terminal vs retryable
// ---------------------------------------------------------------------------

describe("makeGraphDerivationHandler", () => {
  it("registration/call shape: returns a MaintenanceJobHandler invoked per job", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource();
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    // A handler is a single-arg async function; the runner calls handler(job).
    await handler(jobFor(payloadFor(s), s.namespace));
    // It exercised the primitive: prior-hash read + anchor upsert happened.
    expect(pool.calls.some((c) => c.sql.includes("SELECT title"))).toBe(true);
    expect(
      pool.calls.some((c) => c.sql.includes("INSERT INTO ob_entities")),
    ).toBe(true);
    // The anchor now records the derived content hash: a second run no-ops.
    const anchor = pool.anchors.find(
      (a) => a.canonical_id === `${SOURCE_ANCHOR_ENTITY_TYPE}:${s.id}`,
    );
    expect(anchor?.content_hash).toBe(s.content_hash);
  });

  it("idempotent rerun: a second run for the same hash converges without new selection", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource();
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    await handler(jobFor(payloadFor(s), s.namespace));
    // After the first run, the source is no longer selectable (hash derived).
    const stillNeeded = await selectSourcesNeedingDerivation(pool, ["team-kb"]);
    expect(stillNeeded.length).toBe(0);
  });

  it("snapshot guard — stale revision is TERMINAL", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ revision: 5 });
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    // The job was enqueued at revision 4; the live row is revision 5.
    await expect(
      handler(jobFor(payloadFor(s, { revision: 4 }), s.namespace)),
    ).rejects.toBeInstanceOf(GraphDerivationTerminalError);
  });

  it("snapshot guard — changed content hash is TERMINAL (obsolete job)", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ content_hash: "b".repeat(64) });
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    await expect(
      handler(
        jobFor(payloadFor(s, { content_hash: "a".repeat(64) }), s.namespace),
      ),
    ).rejects.toBeInstanceOf(GraphDerivationTerminalError);
  });

  it("snapshot guard — revoked approval is TERMINAL", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ approval_state: "rejected" });
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    await expect(
      handler(jobFor(payloadFor(s), s.namespace)),
    ).rejects.toBeInstanceOf(GraphDerivationTerminalError);
  });

  it("missing namespace on the job is TERMINAL", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource();
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    await expect(handler(jobFor(payloadFor(s), null))).rejects.toBeInstanceOf(
      GraphDerivationTerminalError,
    );
  });

  it("malformed payload is TERMINAL", async () => {
    const pool = new FakeSourcePool();
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    const bad = jobFor(
      { source_id: "not-a-uuid" } as unknown as GraphDerivationPayload,
      "team-kb",
    );
    await expect(handler(bad)).rejects.toBeInstanceOf(
      GraphDerivationTerminalError,
    );
    // Fail-closed: no source read, no graph write attempted.
    expect(pool.calls.length).toBe(0);
  });

  it("cross-namespace negative: an identity that cannot write the job namespace is TERMINAL, no reads", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ namespace: "tenant-b" });
    pool.sources.push(s);
    const readonly: AuthInfo = { role: "readonly", clientId: "viewer" };
    const handler = makeGraphDerivationHandler({
      pool: pool as never,
      auth: readonly,
    });
    await expect(
      handler(jobFor(payloadFor(s), "tenant-b")),
    ).rejects.toBeInstanceOf(GraphDerivationTerminalError);
    // Rejected before the snapshot read: no SQL issued.
    expect(pool.calls.length).toBe(0);
  });

  it("cross-namespace negative: header identity cannot derive into a foreign namespace", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ namespace: "tenant-b" });
    pool.sources.push(s);
    const delegated: AuthInfo = {
      role: "agent",
      clientId: "tenant-a",
      namespaceSource: "header",
    };
    const handler = makeGraphDerivationHandler({
      pool: pool as never,
      auth: delegated,
    });
    await expect(
      handler(jobFor(payloadFor(s), "tenant-b")),
    ).rejects.toBeInstanceOf(GraphDerivationTerminalError);
    expect(pool.calls.length).toBe(0);
  });

  it("transient DB error is RETRYABLE (rethrown, not terminal)", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource();
    pool.sources.push(s);
    // Make the snapshot-guard read fail transiently.
    const original = pool.query;
    let failed = false;
    pool.query = (async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("SELECT title") && !failed) {
        failed = true;
        throw new Error("connection reset");
      }
      return original(sql, params);
    }) as never;
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    await expect(handler(jobFor(payloadFor(s), s.namespace))).rejects.toThrow(
      "connection reset",
    );
    // A retryable error is NOT the terminal subclass.
    try {
      await handler(jobFor(payloadFor(s), s.namespace));
    } catch (err) {
      expect(err).not.toBeInstanceOf(GraphDerivationTerminalError);
    }
  });

  it("content-free: the handler never surfaces the source title in its thrown terminal reason", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ title: "SECRET-PROJECT-CODENAME", revision: 9 });
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    try {
      await handler(jobFor(payloadFor(s, { revision: 1 }), s.namespace));
      throw new Error("expected throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(
        "SECRET-PROJECT-CODENAME",
      );
    }
  });

  it("content-free logs: a successful handler run logs no namespace, hash, id, title, or external id", async () => {
    const pool = new FakeSourcePool();
    const s = makeSource({ title: "SECRET-PROJECT-CODENAME" });
    pool.sources.push(s);
    const handler = makeGraphDerivationHandler({ pool: pool as never, auth });
    const fields = await captureLoggerFields(async () => {
      await handler(jobFor(payloadFor(s), s.namespace));
    });
    // The handler_ok line (and the primitive's own ok line) WAS emitted.
    expect(fields.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("team-kb"); // namespace value
    expect(serialized).not.toContain(s.content_hash as string); // content hash
    expect(serialized).not.toContain(s.id); // source / anchor id
    expect(serialized).not.toContain("SECRET-PROJECT-CODENAME"); // title
    expect(serialized).not.toContain(s.external_id); // external id
    // No 64-char sha256 hex (content_hash OR derivation_hash) in any field.
    for (const entry of fields) {
      for (const value of Object.values(entry)) {
        if (typeof value === "string") {
          expect(value).not.toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
  });
});

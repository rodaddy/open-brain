# Open Brain v2 — Implementation Plan

> Session lanes, event journals, entity graphs, and lane-aware tooling.
> Issues: #34–#40 · Test DB: PG 17.9 on Mac Mini M4, port 5433

---

## Current State (v1)

**5 core tables:** `thoughts`, `decisions`, `relationships`, `projects`, `sessions`
**Supporting tables:** `entry_access_log`, `discarded_entries`, `_migrations`
**21 MCP tools** registered via `registerAllTools(server, deps)` where `deps = { pool, embedFn }`
**Migrations 001–009:** sequential `.sql` files, tracked in `_migrations(filename, applied_at)`, runner in `src/db/migrate.ts` (BEGIN/COMMIT per file, ROLLBACK on error)
**Columns shared across all 5 tables:** `id UUID PK`, `embedding halfvec(768)`, `content_hash`, `tags TEXT[]`, `namespace TEXT NOT NULL DEFAULT 'collab'`, `tier TEXT CHECK (hot|warm|cold)`, `archived_at`, `access_count`, `last_accessed_at`, `usefulness_score`, `search_vector tsvector GENERATED STORED`, `created_by TEXT`, `created_at/updated_at TIMESTAMPTZ`
**Auth:** token-based RBAC (`admin|agent|discord|n8n|readonly`), checked via `canRead()/canWrite()` from `src/permissions.ts`
**Tool pattern:** `server.registerTool(name, { description, inputSchema: { ...z.fields }, annotations }, async (args, extra) => { ... })` — returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`

---

## Phase 0: Test DB Setup ✅

- PG 17.9, Mac Mini M4 (`10.71.1.21`), port **5433**
- Data dir: `/Volumes/ThunderBolt/Development/postgres-data`
- DB name: `open_brain_test`, pgvector **0.8.2**
- Verify: `psql -h localhost -p 5433 -d open_brain_test -c "SELECT extversion FROM pg_extension WHERE extname='vector'"`

---

## Phase 1: Schema — Session Lanes + Event Journal + Entity Graph

All three tables ship in **migration 010**. Each can be a separate PR for parallel work.

### #34 — `ob_session_lanes` (Skippy)

Durable work-context lanes keyed by namespace + session_key. Replaces ad-hoc `sessions` table usage for active context tracking.

```sql
-- Migration 010a: Session lanes
CREATE TABLE ob_session_lanes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace     TEXT NOT NULL DEFAULT 'collab',
  session_key   TEXT NOT NULL,           -- e.g. "hermes-agent/skippy"
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','wrapped')),
  goal          TEXT,                    -- what this lane is trying to accomplish
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  wrapped_at    TIMESTAMPTZ,
  started_by    TEXT NOT NULL,           -- agent clientId
  wrapped_by    TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_lane_active
  ON ob_session_lanes (namespace, session_key)
  WHERE status = 'active';
CREATE INDEX idx_lane_namespace ON ob_session_lanes (namespace, status);
CREATE INDEX idx_lane_session_key ON ob_session_lanes (session_key, created_at DESC);

-- Trigger reuse from 001
CREATE TRIGGER trg_lanes_updated_at
  BEFORE UPDATE ON ob_session_lanes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

**Key constraint:** Only one active lane per `(namespace, session_key)` — enforced by the partial unique index.

### Entity/Link Design Rules

**Namespace consistency on links:**
- `ob_links` has its own `namespace` column. Insert/update helpers MUST verify both `from_entity` and `to_entity` belong to that namespace unless the caller explicitly passes `cross_namespace=true`.
- Plain FK on UUID alone won't prevent cross-namespace edges — enforce in the `link_entity` tool's insert logic and test it.

**Alias collision / merge semantics:**
- Unique `(namespace, kind, name)` applies to canonical names only. Aliases can collide with another entity's canonical name.
- Lookup order: exact canonical match wins → alias match returns candidates (never auto-merge).
- Merges: set old entity `status='merged'`, set `merged_into` to the replacement entity UUID. Old refs continue to resolve via redirect.
- `adjacent_context` and `link_entity` follow `merged_into` chains (max depth 3) to resolve current entity.

**Link directionality (documented, not schema-enforced):**
- Symmetric: `related_to`, `contradicts` — queries return both directions.
- Directional: `depends_on`, `supersedes`, `implements`, `owned_by`, `belongs_to`, `blocks`, `runs_on`, `produces`, `consumes`, `mentions`, `member_of` — queries respect `from_entity` → `to_entity` direction.
- Tests must cover both patterns.

### #35 — `ob_session_events` (Skippy)

Append-only event journal. Every fact, decision, blocker, or artifact gets logged as an event against a lane.

```sql
-- Migration 010b: Session events (append-only journal)
CREATE TYPE ob_event_kind AS ENUM (
  'fact', 'decision', 'blocker', 'artifact',
  'question', 'progress', 'handoff', 'note'
);

CREATE TABLE ob_session_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_id       UUID NOT NULL REFERENCES ob_session_lanes(id),
  kind          ob_event_kind NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  source        TEXT DEFAULT 'agent',    -- who/what produced this event
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_events_lane ON ob_session_events (lane_id, created_at);
CREATE INDEX idx_events_kind ON ob_session_events (kind, created_at DESC);
CREATE INDEX idx_events_embedding ON ob_session_events
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

**No `updated_at`:** append-only. Events are immutable once written.

### #38 — `ob_entities` + `ob_links` (Bilby)

Explicit entity/adjacency graph. Entities are named things (people, projects, repos, hosts). Links are typed, directional relationships between them.

```sql
-- Migration 010c: Entity graph
CREATE TABLE ob_entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace     TEXT NOT NULL DEFAULT 'collab',
  kind          TEXT NOT NULL,           -- 'person', 'project', 'repo', 'host', 'concept', etc.
  name          TEXT NOT NULL,           -- canonical name
  aliases       TEXT[] DEFAULT '{}',     -- alternate names / abbreviations
  slug          TEXT NOT NULL,           -- normalized key: lower(regexp_replace(name, '\W+', '-', 'g'))
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived','merged')),
  merged_into   UUID REFERENCES ob_entities(id),  -- set when status='merged'
  source_refs   JSONB DEFAULT '[]',      -- provenance: discord/session/PR/file refs
  metadata      JSONB DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE UNIQUE INDEX idx_entity_unique ON ob_entities (namespace, kind, name);
CREATE UNIQUE INDEX idx_entity_slug ON ob_entities (namespace, kind, slug);
CREATE INDEX idx_entity_kind ON ob_entities (kind);
CREATE INDEX idx_entity_status ON ob_entities (namespace, status);
CREATE INDEX idx_entity_aliases ON ob_entities USING GIN (aliases);
CREATE INDEX idx_entity_metadata ON ob_entities USING GIN (metadata);
CREATE INDEX idx_entity_embedding ON ob_entities
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE TABLE ob_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace     TEXT NOT NULL DEFAULT 'collab',
  from_entity   UUID NOT NULL REFERENCES ob_entities(id),
  to_entity     UUID NOT NULL REFERENCES ob_entities(id),
  relation      TEXT NOT NULL             -- 'owns', 'blocks', 'depends_on', 'member_of', etc.
                CHECK (relation IN (
                  'depends_on','supersedes','contradicts','mentions',
                  'implements','belongs_to','owned_by','related_to',
                  'blocks','member_of','runs_on','produces','consumes'
                )),
  weight        FLOAT DEFAULT 1.0,
  confidence    FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source_refs   JSONB DEFAULT '[]',      -- provenance for this edge
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),
  metadata      JSONB DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT no_self_link CHECK (from_entity != to_entity)
);

CREATE INDEX idx_link_from ON ob_links (from_entity, relation);
CREATE INDEX idx_link_to ON ob_links (to_entity, relation);
CREATE INDEX idx_link_ns ON ob_links (namespace, relation);
CREATE UNIQUE INDEX idx_link_unique ON ob_links (from_entity, to_entity, relation);

-- Join table: events ↔ entities
CREATE TABLE ob_event_entities (
  event_id      UUID NOT NULL REFERENCES ob_session_events(id),
  entity_id     UUID NOT NULL REFERENCES ob_entities(id),
  role          TEXT NOT NULL DEFAULT 'subject'
                CHECK (role IN ('subject','object','context','owner')),
  PRIMARY KEY (event_id, entity_id, role)
);
CREATE INDEX idx_event_entities_entity ON ob_event_entities (entity_id);

CREATE TRIGGER trg_entities_updated_at
  BEFORE UPDATE ON ob_entities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

---

## Phase 2: MCP Tools — Lane-Aware Operations

### #36 — Core Session Tools (Split)

**Skippy builds:**

**`session_context`** — Get full context for the current active lane: lane metadata + recent events.
```ts
server.registerTool("session_context", {
  description: "Load active session lane context with recent events",
  inputSchema: {
    namespace: z.string().optional().describe("Namespace (default: 'collab')"),
    session_key: z.string().describe("Session key, e.g. 'hermes-agent/skippy'"),
    event_limit: z.number().int().min(1).max(100).optional()
      .describe("Max events to return (default: 20)"),
    kind: z.enum(['fact','decision','blocker','artifact','question','progress','handoff','note'])
      .optional().describe("Filter events by kind"),
  },
  annotations: { title: "Session Context", readOnlyHint: true, ... },
}, async (args, extra) => { ... });
```

**`append_session_event`** — Append an event to the active lane.
```ts
server.registerTool("append_session_event", {
  description: "Append a fact, decision, blocker, or artifact to the active session lane",
  inputSchema: {
    namespace: z.string().optional(),
    session_key: z.string(),
    kind: z.enum(['fact','decision','blocker','artifact','question','progress','handoff','note']),
    content: z.string().min(1),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  annotations: { title: "Append Session Event", readOnlyHint: false, ... },
}, async (args, extra) => { ... });
```

### #39 — Lane + Entity Tools (Split)

**Bilby builds:**

**`start_session_lane`** — Create a new active lane (fails if one already active for that key).
```ts
server.registerTool("start_session_lane", {
  inputSchema: {
    namespace: z.string().optional(),
    session_key: z.string(),
    title: z.string().min(1),
    goal: z.string().optional(),
  },
  ...
});
```

**`list_active_lanes`** — List all active/paused lanes, optionally filtered by namespace.
```ts
server.registerTool("list_active_lanes", {
  inputSchema: {
    namespace: z.string().optional(),
    status: z.enum(['active','paused','wrapped']).optional(),
  },
  ...
});
```

**`link_entity`** — Upsert an entity and/or create a link between two entities.
```ts
server.registerTool("link_entity", {
  inputSchema: {
    namespace: z.string().optional(),
    from: z.object({ kind: z.string(), name: z.string() }),
    to: z.object({ kind: z.string(), name: z.string() }),
    relation: z.string(),
    weight: z.number().optional(),
  },
  ...
});
```

**`adjacent_context`** — Walk the entity graph: given an entity, return all linked entities + their recent events.
```ts
server.registerTool("adjacent_context", {
  inputSchema: {
    namespace: z.string().optional(),
    kind: z.string(),
    name: z.string(),
    depth: z.number().int().min(1).max(3).optional().describe("Graph walk depth (default: 1)"),
  },
  ...
});
```

**Skippy builds:**

**`wrap_session_lane`** — Close an active lane, auto-generate a summary from events, push to `sessions` table for backward compat.
```ts
server.registerTool("wrap_session_lane", {
  inputSchema: {
    namespace: z.string().optional(),
    session_key: z.string(),
    summary: z.string().optional().describe("Override summary (auto-generated if omitted)"),
  },
  ...
});
```

---

## Phase 3: Session Start/Wrap Workflow (#37)

**Both agents:**

1. On session start, agent calls `session_context` → if no active lane, calls `start_session_lane`
2. During session, agent calls `append_session_event` for significant facts/decisions/blockers
3. On session end (compaction/explicit wrap), agent calls `wrap_session_lane` → generates summary → pushes to `sessions` table → marks lane as `wrapped`
4. Enforcement: add `lane_id` column to `sessions` table (FK to `ob_session_lanes`) linking wrap output to its source lane

**Migration 011:**
```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lane_id UUID REFERENCES ob_session_lanes(id);
CREATE INDEX IF NOT EXISTS idx_sessions_lane ON sessions (lane_id);
```

---

## Phase 4: Contract Doc (#40)

**Both agents:**

Write `docs/ob-contract.md` defining the three-layer architecture:
1. **Open Brain** = operational memory (tables, tools, embeddings, tiers)
2. **Overlay** = behavior law (system prompts, rules, personas — lives in Hermes config)
3. **session_search** = transcript recall (Claude Code session transcripts, external to OB)

Boundaries: OB stores *distilled* facts and decisions. It does NOT store raw transcripts. `session_search` is the tool for transcript recall. Overlay is not stored in OB.

---

## Type System Updates

Add to `src/types.ts`:
```ts
export type Table = "thoughts" | "decisions" | "relationships" | "projects" | "sessions"
  | "ob_session_lanes" | "ob_session_events" | "ob_entities" | "ob_links";

export type EventKind = "fact" | "decision" | "blocker" | "artifact"
  | "question" | "progress" | "handoff" | "note";

export type LaneStatus = "active" | "paused" | "wrapped";
```

Update `src/permissions.ts` RBAC matrix to include new tables (`agent` gets RW on all v2 tables).

Update `src/tools/table-constants.ts`: add `ALL_TABLES`, `SOURCE_LABELS`, `CONTENT_PREVIEW`, `TABLE_ALIAS` entries for new tables.

---

## Agent Assignment

| Issue | Owner | Depends On |
|-------|-------|------------|
| #34 `ob_session_lanes` | Skippy | — |
| #35 `ob_session_events` | Skippy | #34 |
| #38 `ob_entities` + `ob_links` | Bilby | — |
| #36 `session_context` + `append_session_event` | Skippy | #34, #35 |
| #39 `start_session_lane` + `list_active_lanes` | Bilby | #34 |
| #39 `link_entity` + `adjacent_context` | Bilby | #38 |
| #39 `wrap_session_lane` | Skippy | #34, #35 |
| #37 Workflow + enforcement | Both | #36, #39 |
| #40 Contract doc | Both | All above |

**Parallel tracks:** Skippy (#34+#35) and Bilby (#38) start simultaneously — no dependencies between them.

---

## PR Workflow

1. **Zero findings:** zero `bun test` failures, zero `bunx tsc --noEmit` errors before requesting review
2. **Alternating review:** one agent approves, the other merges — no self-merge, no `--admin`
3. **Rico merges to main** — agents merge to `develop`, Rico promotes to `main`
4. Branch naming: `feat/ob-v2-session-lanes`, `feat/ob-v2-entity-graph`, etc.

---

## Test Plan

All new tools get tests in `src/tools/__tests__/` following existing patterns (see `session-save.test.ts`, `search-brain.test.ts`).

| Test | Coverage |
|------|----------|
| Migration 010 applies cleanly on empty + existing DB | `src/db/migrations/010_*.test.ts` |
| `start_session_lane` creates lane, rejects duplicate active | tool test |
| `append_session_event` writes event, embeds content | tool test |
| `session_context` loads lane + events, respects `kind` filter | tool test |
| `wrap_session_lane` transitions status, generates `sessions` row | tool test |
| `link_entity` upserts entities, creates link, rejects self-link | tool test |
| `adjacent_context` walks 1-hop and 2-hop correctly | tool test |
| RBAC: new tables respect role permissions | permission test |
| Partial unique index on `ob_session_lanes` prevents 2 active lanes | constraint test |

**Run against test DB:** `DB_HOST=localhost DB_PORT=5433 DB_NAME=open_brain_test bun test`

---

## Cutover Plan (Prod)

1. **Backup:** `pg_dump -h 10.71.20.15 -d open_brain -Fc -f ob_pre_v2_$(date +%Y%m%d).dump`
2. **Migrate schema:** `DB_HOST=10.71.20.15 bun run migrate` — new tables only, no existing table modifications until Phase 3
3. **Backfill canonical entities:** script to scan `relationships` and `projects` tables → upsert into `ob_entities`
4. **Enable reads first:** deploy v2 code with new tools visible but v1 tools unchanged
5. **Enable writes:** flip agents to use new session lane workflow
6. **Rollback path:** v2 tables are additive — drop `ob_session_lanes`, `ob_session_events`, `ob_entities`, `ob_links` to revert. No v1 tables are modified until Phase 3's `ALTER TABLE sessions ADD COLUMN lane_id`

---

*Last updated: 2026-06-05 · Authors: Skippy + Bilby · Approver: Rico*

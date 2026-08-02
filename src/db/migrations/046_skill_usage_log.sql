-- 046 — Skill and canon usage telemetry: who invoked what, where, and when.
--
-- Issue #469. The operator's ruling is the whole design premise: "no automatic
-- retirement. What I need is something that gives me metrics so that decisions
-- can be made on facts and not on feel." This table stores facts about
-- invocations and nothing else. It carries no verdict column, no score, no
-- ranking, and no lifecycle state, because a column shaped like a judgement is
-- an invitation to write one, and the issue body forbids that in terms: the
-- telemetry "must never categorize, recommend, rotate, shelve, or retire
-- anything." Rico reads the counts and decides.
--
-- WHY A NEW TABLE INSTEAD OF entry_access_log.
--
-- Issue #469's title proposes logging into `entry_access_log`, and that table
-- genuinely cannot hold these rows. Its DDL at 006_cognitive_tiering.sql:34
-- declares
--
--     source_table TEXT NOT NULL
--       CHECK (source_table IN
--              ('thoughts','decisions','relationships','projects','sessions'))
--
-- so the CHECK CONSTRAINT rejects every value outside those five entry tables.
-- A skill invocation points at an `ob_entities` row (`skill.<slug>`), which is
-- not one of the five, so an insert naming it fails the CHECK. Widening that
-- enumeration is the wrong repair: `entry_access_log.entry_id` is read by the
-- tiering and access-report paths as an entry-table id — `reporting.ts`
-- `accessLogStats()` derives its namespace by joining `entry_id` back to the
-- table named in `source_table` — so admitting a non-entry id there would make
-- every one of those joins silently miss rows. The five-table enumeration is
-- load-bearing, so the new fact gets its own table.
--
-- WHY THE ENTITY REFERENCE IS THE SCOPE KEY, NOT A NAMESPACE COLUMN.
--
-- This log carries no `namespace` column, matching `entry_access_log`'s shape
-- deliberately. `reporting.ts:360-398` establishes the rule the reader must
-- follow: the log has no namespace of its own, so every read joins back to the
-- owning row and applies the auth predicate THERE. Duplicating the namespace
-- onto the log row would create a second copy that can disagree with the
-- entity's after a namespace move, and the stale copy is what a reader would
-- then filter on. One authority: `ob_entities.namespace`, reached by join.
--
-- WHY NO INDEX BEYOND THE PRIMARY KEY YET.
--
-- 008_index_cleanup.sql dropped all three non-PK indexes on `entry_access_log`
-- with the note "write-only table, 0 scans" — the log had never been read. The
-- lesson recorded in #469 is to add an index when measurement shows the read
-- needs it, not on the guess that it will. `skill_usage_log` DOES get read from
-- day one (`skill_usage_report` is shipping with it), so it gets exactly the
-- one index that read uses — the entity/time pair the report groups and orders
-- by — and no speculative others.

CREATE TABLE IF NOT EXISTS skill_usage_log (
    id            BIGSERIAL PRIMARY KEY,
    -- The `ob_entities` row this invocation points at (`entity_type`
    -- 'skill', name `skill.<slug>`). No FOREIGN KEY, matching the
    -- `ob_entities`/`ob_links` convention from 010_entity_links.sql: the
    -- graph tables are deliberately reference-only so a writer never fails
    -- because a seed has not landed yet. An orphan row is a countable fact
    -- that simply joins to nothing in the report.
    entity_id     UUID NOT NULL,
    -- The invocation metrics themselves, all four dimensions #469 asks for:
    -- which skill, which agent, which repo, which session.
    skill_slug    TEXT NOT NULL,
    agent         TEXT,
    repo          TEXT,
    session_id    TEXT,
    -- Which harness emitted this. Claude Code's PostToolUse hook is the first;
    -- Codex and Pi arrive later through their own hook chains, and the report
    -- groups by this so the three never blur together.
    runtime       TEXT,
    -- What kind of thing was invoked. Skills and canon rules are both counted
    -- by #469 ("which canon rules load where, feeding the router dedupe work"),
    -- and they are counted separately, so the kind is recorded rather than
    -- inferred from the slug.
    usage_kind    TEXT NOT NULL DEFAULT 'skill'
                  CHECK (usage_kind IN ('skill', 'canon')),
    invoked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (btrim(skill_slug) <> '')
);

-- The one read this table has: the report groups by entity and orders by time.
CREATE INDEX IF NOT EXISTS idx_skill_usage_entity_time
    ON skill_usage_log (entity_id, invoked_at DESC);

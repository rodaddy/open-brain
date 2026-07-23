// Live-Postgres integration suite for the structured guidance and repo_facts
// sections (issue #328 / PR #357). The sibling
// `agent-context-pack-guidance-repo-facts.test.ts` drives the same paths through
// a SQL-routing fake pool; this suite executes the ACTUAL guidance lifecycle SQL
// (ob_session_events joined to ob_session_lanes on namespace) and the ACTUAL
// repo_fact SQL (ob_entities bound to entity_type='repo_fact' + namespace +
// metadata->>'repo') against a migrated Postgres, so the real predicates —
// including the ::float8 candidate_confidence cast, the candidate_scope.key JSON
// path, and the exact repo/namespace binds — are proven, not mocked.
//
// Gated on OPENBRAIN_TEST_DATABASE_URL; skipped when absent (reported truthfully
// as skipped, never as passed). Every row is inserted under a pid-scoped
// namespace and cleaned up before and after, so no live infrastructure state is
// mutated beyond the disposable test namespaces.

import { afterAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import type { AuthInfo } from "../../types.ts";
import { setupAgentContextPackToolClient as setupToolClient } from "./agent-context-pack-test-helpers.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

type Row = Record<string, unknown>;

dbDescribe("agent_context_pack guidance + repo_facts (live Postgres)", () => {
  const pool = new Pool({
    connectionString: DB_URL,
    max: 2,
    connectionTimeoutMillis: 500,
  });

  // Two disjoint namespaces prove isolation/non-fallback against the real SQL:
  // the caller reads only `namespace`, and the `otherNamespace` rows (with their
  // own repo) must never surface.
  const namespace = `test-guidance-live-${process.pid}`;
  const otherNamespace = `test-guidance-live-other-${process.pid}`;

  const repo = "rodaddy/open-brain";
  const otherRepo = "rodaddy/king-signals";

  const scope = {
    agent: "nagatha",
    platform: "discord",
    server_id: "live-server",
    channel_id: "live-channel",
  };
  const laneId = "20000000-0000-0000-0000-000000000001";
  const otherLaneId = "20000000-0000-0000-0000-000000000002";

  async function cleanupRows() {
    for (const ns of [namespace, otherNamespace]) {
      await pool.query(
        `DELETE FROM ob_session_events
          WHERE lane_id IN (SELECT id FROM ob_session_lanes WHERE namespace = $1)`,
        [ns],
      );
      await pool.query("DELETE FROM ob_session_lanes WHERE namespace = $1", [
        ns,
      ]);
      await pool.query(
        "DELETE FROM ob_entities WHERE namespace = $1 AND entity_type = 'repo_fact'",
        [ns],
      );
    }
  }

  async function insertLane(id: string, ns: string, sessionKey: string) {
    await pool.query(
      `INSERT INTO ob_session_lanes
         (id, session_key, namespace, agent, source, channel_id, thread_id,
          project, topic, current_context_md, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'open-brain', 'live guidance',
               'live checkpoint', jsonb_build_object('server_id', $7::text), 'test')`,
      [
        id,
        sessionKey,
        ns,
        scope.agent,
        scope.platform,
        scope.channel_id,
        scope.server_id,
      ],
    );
  }

  /**
   * Insert a promoted user_preference lifecycle event with a NUMERIC
   * candidate_confidence and an explicit candidate_scope.key — the two typed
   * metadata fields the real guidance SQL casts/extracts. jsonb_build_object
   * stores candidate_confidence as a JSON number so the `::float8` cast in the
   * loader query exercises a real numeric value, not a string.
   */
  async function insertPromotedPreference(
    laneRef: string,
    id: string,
    content: string,
    confidence: number,
    scopeKey: string,
  ) {
    await pool.query(
      `INSERT INTO ob_session_events
         (id, lane_id, event_type, content, source, importance, metadata, created_by)
       VALUES ($1, $2, 'decision', $3, 'test', 'warm',
               jsonb_build_object(
                 'memory_lifecycle_action', 'promote',
                 'candidate_type', 'user_preference',
                 'candidate_reason', 'stated preference',
                 'candidate_confidence', $4::float8,
                 'candidate_scope', jsonb_build_object('key', $5::text)
               ),
               'test')`,
      [id, laneRef, content, confidence, scopeKey],
    );
  }

  /** Insert a repo_fact entity bound to an exact repo + namespace. */
  async function insertRepoFact(
    ns: string,
    factRepo: string,
    name: string,
    fact: string,
    sourceCommit: string,
  ) {
    await pool.query(
      `INSERT INTO ob_entities
         (entity_type, name, namespace, metadata, created_by)
       VALUES ('repo_fact', $1, $2,
               jsonb_build_object(
                 'repo', $3::text,
                 'path', 'src/tools/repo-facts.ts',
                 'subject', 'repoFactMetadata',
                 'fact_type', 'api_contract',
                 'fact', $4::text,
                 'source_commit', $5::text,
                 'source_url', $6::text,
                 'verified_at', '2026-07-20T09:00:00Z',
                 'confidence', 1,
                 'staleness_policy', 'stable_fact_verify_source'
               ),
               'test')`,
      [
        name,
        ns,
        factRepo,
        fact,
        sourceCommit,
        `https://github.com/${factRepo}/blob/${sourceCommit}/src/tools/repo-facts.ts`,
      ],
    );
  }

  async function callLivePack(callerNamespace: string) {
    // Admin clientId resolves to the read namespace, exercising the real
    // auth-derived namespace predicate the loaders bind on.
    const auth: AuthInfo = { role: "admin", clientId: callerNamespace };
    const { client, cleanup } = await setupToolClient(auth, pool as any);
    try {
      const pack = await client.callTool({
        name: "agent_context_pack",
        arguments: {
          namespace: callerNamespace,
          agent: scope.agent,
          platform: scope.platform,
          server_id: scope.server_id,
          channel_id: scope.channel_id,
          session_key: `live-${callerNamespace}`,
          requested_sections: ["profile_guidance", "repo_facts"],
          repo,
        },
      });
      return JSON.parse((pack.content as any)[0].text);
    } finally {
      await cleanup();
    }
  }

  afterAll(async () => {
    await cleanupRows();
    await pool.end();
  });

  it("executes the real guidance + repo_facts SQL and proves namespace/repo isolation", async () => {
    await cleanupRows();
    try {
      // Caller namespace: one promoted preference and one exact-repo fact.
      await insertLane(laneId, namespace, `live-${namespace}`);
      await insertPromotedPreference(
        laneId,
        "20000000-0000-0000-0000-0000000000a1",
        "prefer concise answers",
        0.92,
        "tone",
      );
      await insertRepoFact(
        namespace,
        repo,
        "repo-facts-api-contract",
        "repo facts require symbol or subject",
        "abc1234",
      );

      // Negative second namespace/repository row: a promoted preference AND a
      // repo_fact bound to a DIFFERENT namespace and a DIFFERENT repo. The real
      // SQL predicates must exclude both — no cross-namespace leak, no cross-repo
      // fallback.
      await insertLane(otherLaneId, otherNamespace, `live-${otherNamespace}`);
      await insertPromotedPreference(
        otherLaneId,
        "20000000-0000-0000-0000-0000000000b1",
        "FOREIGN preference must not leak",
        0.5,
        "foreign-tone",
      );
      await insertRepoFact(
        otherNamespace,
        otherRepo,
        "foreign-repo-fact",
        "FOREIGN fact must not leak",
        "def5678",
      );
      // Same namespace, WRONG repo: proves repo_facts binds the active repo
      // exactly and never falls back to another repo within the namespace.
      await insertRepoFact(
        namespace,
        otherRepo,
        "wrong-repo-fact",
        "WRONG-repo fact must not surface",
        "999aaaa",
      );

      const payload = await callLivePack(namespace);

      // profile_guidance: exactly the caller-namespace promoted preference, with
      // the numeric confidence and scope key the real SQL cast/extracted.
      const guidance = payload.sections.profile_guidance;
      expect(guidance).toMatchObject({
        label: "profile_guidance",
        candidate_type: "user_preference",
        namespace_bound: true,
        item_count: 1,
      });
      const prefItem = guidance.items[0];
      expect(prefItem.guidance).toBe("prefer concise answers");
      expect(prefItem.confidence).toBe(0.92);
      expect(prefItem.scope_key).toBe("tone");
      expect(prefItem.supersession_verifiable).toBe(true);
      // The foreign-namespace preference never leaked in.
      expect(
        guidance.items.some((i: Row) => String(i.guidance).includes("FOREIGN")),
      ).toBe(false);

      // repo_facts: exactly the exact-repo fact for this namespace.
      const repoFacts = payload.sections.repo_facts;
      expect(repoFacts).toMatchObject({
        label: "repo_facts",
        repo,
        namespace_bound: true,
        repo_bound: true,
        item_count: 1,
      });
      const factItem = repoFacts.items[0];
      expect(factItem.repo).toBe(repo);
      expect(factItem.fact).toBe("repo facts require symbol or subject");
      expect(factItem.source_commit).toBe("abc1234");
      expect(factItem.staleness_disposition).toBe("source_pinned");
      // Neither the foreign-namespace fact nor the wrong-repo same-namespace fact
      // surfaced: the real SQL bound namespace AND repo exactly.
      expect(
        repoFacts.items.some((i: Row) => String(i.fact).includes("FOREIGN")),
      ).toBe(false);
      expect(
        repoFacts.items.some((i: Row) => String(i.fact).includes("WRONG-repo")),
      ).toBe(false);

      // Citation bijection over the real reads: one session_event citation for the
      // preference, one repo_fact citation for the fact — no more.
      expect(
        payload.citations.filter((c: Row) => c.kind === "session_event"),
      ).toHaveLength(1);
      expect(
        payload.citations.filter((c: Row) => c.kind === "repo_fact"),
      ).toHaveLength(1);
      const factCitation = payload.citations.find(
        (c: Row) => c.kind === "repo_fact",
      );
      expect(factCitation?.source_commit).toBe("abc1234");
    } finally {
      await cleanupRows();
    }
  });

  it("proves the second namespace reads only its own guidance and repo (non-fallback)", async () => {
    await cleanupRows();
    try {
      await insertLane(otherLaneId, otherNamespace, `live-${otherNamespace}`);
      await insertPromotedPreference(
        otherLaneId,
        "20000000-0000-0000-0000-0000000000c1",
        "OTHER-namespace preference",
        0.7,
        "other-tone",
      );
      // The active repo requested by callLivePack (`repo`) has NO fact in the
      // other namespace, so repo_facts must be the defined empty state — never
      // the first namespace's fact.
      await insertRepoFact(
        otherNamespace,
        otherRepo,
        "other-only-fact",
        "only in the other repo",
        "def5678",
      );

      const payload = await callLivePack(otherNamespace);

      // Guidance: only the other namespace's own promoted preference.
      expect(payload.sections.profile_guidance.item_count).toBe(1);
      expect(payload.sections.profile_guidance.items[0].guidance).toBe(
        "OTHER-namespace preference",
      );
      // repo_facts for the requested `repo` in this namespace: defined empty
      // state, proving no cross-namespace/cross-repo fallback in the real SQL.
      expect(payload.sections.repo_facts).toMatchObject({
        repo,
        repo_bound: true,
        item_count: 0,
        truncated: false,
      });
      expect(payload.sections.repo_facts.items).toEqual([]);
    } finally {
      await cleanupRows();
    }
  });
});

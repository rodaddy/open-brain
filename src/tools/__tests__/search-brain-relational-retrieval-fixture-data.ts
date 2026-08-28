// Fixture data for the search_brain relational retrieval eval: types, entries,
// entities, relational questions, and links. Holds no test and creates no pool.

export type SourceType = "thought" | "decision" | "session" | "project";

export type FixtureEntry = {
  id: string;
  source_type: SourceType;
  namespace: string;
  text: string;
  archived_at?: string | null;
};

export type FixtureEntity = {
  id: string;
  namespace: string;
  name: string;
  entity_type: string;
  archived_at?: string | null;
};

export type FixtureLink = {
  id: string;
  namespace: string;
  from_type: "entity" | SourceType;
  from_id: string;
  to_type: "entity" | SourceType;
  to_id: string;
  relation: string;
  archived_at?: string | null;
};

export type RelationalQuestion = {
  id: string;
  question: string;
  namespace: string;
  seed: string;
  relation: string;
  direction: "incoming" | "outgoing";
  expected_id: string;
  expected_type: SourceType;
};

export const entries: FixtureEntry[] = [
  {
    id: "thought-deploy-readiness",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Readiness packet confirms the release train passed local checks.",
  },
  {
    id: "decision-schema-v11",
    source_type: "decision",
    namespace: "shared-kb",
    text: "Schema v11 remains the selected contract after downstream review.",
  },
  {
    id: "session-worker-handoff",
    source_type: "session",
    namespace: "shared-kb",
    text: "Worker handoff captured exact validation evidence for the canary.",
  },
  {
    id: "project-promoter-cleanup",
    source_type: "project",
    namespace: "shared-kb",
    text: "Promoter cleanup project owns stale collab migration follow-through.",
  },
  {
    id: "thought-auth-boundary",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Auth boundary note names server-side namespace predicates as mandatory.",
  },
  {
    id: "decision-qmd-fallback",
    source_type: "decision",
    namespace: "shared-kb",
    text: "QMD fallback stays separate from Open Brain graph evidence.",
  },
  {
    id: "session-review-gauntlet",
    source_type: "session",
    namespace: "shared-kb",
    text: "Review gauntlet receipt lists SME and antagonist verification lanes.",
  },
  {
    id: "thought-hot-memory-defer",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Hot memory prompt placement is deferred until exact-scope tests exist.",
  },
  {
    id: "decision-nats-gate",
    source_type: "decision",
    namespace: "shared-kb",
    text: "NATS rollout gate remains outside the graph retrieval sprint.",
  },
  {
    id: "session-archive-safety",
    source_type: "session",
    namespace: "shared-kb",
    text: "Archive safety session excludes soft-deleted graph nodes from answers.",
  },
  {
    id: "thought-db-owner",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Database owner repair requires backup proof before migration retry.",
  },
  {
    id: "project-docs-site",
    source_type: "project",
    namespace: "shared-kb",
    text: "Docs site project keeps source HTML in specs and published HTML in collab sites.",
  },
  {
    id: "decision-python-floor",
    source_type: "decision",
    namespace: "shared-kb",
    text: "Python package floor moves to 3.13 for fleet bus compatibility.",
  },
  {
    id: "thought-redaction-superset",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Redaction superset adds bare token and high entropy detectors.",
  },
  {
    id: "session-canary-proof",
    source_type: "session",
    namespace: "shared-kb",
    text: "Canary proof records contract version, tool list, and hosted health.",
  },
  {
    id: "decision-shared-kb",
    source_type: "decision",
    namespace: "shared-kb",
    text: "Shared knowledge canonical namespace remains shared-kb.",
  },
  {
    id: "thought-mcp-cache",
    source_type: "thought",
    namespace: "shared-kb",
    text: "MCP schema cache refresh is required after contract deployment.",
  },
  {
    id: "project-dreamengine",
    source_type: "project",
    namespace: "shared-kb",
    text: "DreamEngine decomposition tracks oversized entries for later splitting.",
  },
  {
    id: "session-agent-context",
    source_type: "session",
    namespace: "shared-kb",
    text: "Agent context contract preserves citations and unpromoted working state.",
  },
  {
    id: "thought-rollback-note",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Rollback note names runtime previous path and launchd restart boundary.",
  },
  {
    id: "private-leak-target",
    source_type: "thought",
    namespace: "private-agent",
    text: "Private agent target must never hydrate through shared-kb graph search.",
  },
  {
    id: "archived-link-target",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Archived link target should be invisible to relational traversal.",
  },
  {
    id: "archived-entity-target",
    source_type: "thought",
    namespace: "shared-kb",
    text: "Archived entity target should be invisible to relational traversal.",
  },
];

export const entities: FixtureEntity[] = [
  { id: "entity-alpha", namespace: "shared-kb", entity_type: "issue", name: "Alpha" },
  { id: "entity-bravo", namespace: "shared-kb", entity_type: "issue", name: "Bravo" },
  {
    id: "entity-charlie",
    namespace: "shared-kb",
    entity_type: "issue",
    name: "Charlie",
  },
  { id: "entity-delta", namespace: "shared-kb", entity_type: "issue", name: "Delta" },
  { id: "entity-echo", namespace: "shared-kb", entity_type: "issue", name: "Echo" },
  {
    id: "entity-foxtrot",
    namespace: "shared-kb",
    entity_type: "issue",
    name: "Foxtrot",
  },
  { id: "entity-golf", namespace: "shared-kb", entity_type: "issue", name: "Golf" },
  { id: "entity-hotel", namespace: "shared-kb", entity_type: "issue", name: "Hotel" },
  { id: "entity-india", namespace: "shared-kb", entity_type: "issue", name: "India" },
  { id: "entity-juliet", namespace: "shared-kb", entity_type: "issue", name: "Juliet" },
  { id: "entity-kilo", namespace: "shared-kb", entity_type: "issue", name: "Kilo" },
  { id: "entity-lima", namespace: "shared-kb", entity_type: "issue", name: "Lima" },
  { id: "entity-mike", namespace: "shared-kb", entity_type: "issue", name: "Mike" },
  {
    id: "entity-november",
    namespace: "shared-kb",
    entity_type: "issue",
    name: "November",
  },
  { id: "entity-oscar", namespace: "shared-kb", entity_type: "issue", name: "Oscar" },
  { id: "entity-papa", namespace: "shared-kb", entity_type: "issue", name: "Papa" },
  { id: "entity-quebec", namespace: "shared-kb", entity_type: "issue", name: "Quebec" },
  { id: "entity-romeo", namespace: "shared-kb", entity_type: "issue", name: "Romeo" },
  { id: "entity-sierra", namespace: "shared-kb", entity_type: "issue", name: "Sierra" },
  { id: "entity-tango", namespace: "shared-kb", entity_type: "issue", name: "Tango" },
  {
    id: "entity-private",
    namespace: "private-agent",
    entity_type: "issue",
    name: "Private",
  },
  {
    id: "entity-archived",
    namespace: "shared-kb",
    entity_type: "issue",
    name: "Archived",
    archived_at: "2026-07-01T00:00:00Z",
  },
];

export const relationalQuestionRows = [
  [
    "q01",
    "What depends on Alpha?",
    "Alpha",
    "depends_on",
    "thought-deploy-readiness",
    "thought",
  ],
  [
    "q02",
    "What is blocked by Bravo?",
    "Bravo",
    "blocked_by",
    "decision-schema-v11",
    "decision",
  ],
  [
    "q03",
    "What was implemented by Charlie?",
    "Charlie",
    "implemented_by",
    "session-worker-handoff",
    "session",
  ],
  [
    "q04",
    "What was decided by Delta?",
    "Delta",
    "decided_by",
    "project-promoter-cleanup",
    "project",
  ],
  [
    "q05",
    "What supersedes Echo?",
    "Echo",
    "supersedes",
    "thought-auth-boundary",
    "thought",
  ],
  [
    "q06",
    "What duplicates Foxtrot?",
    "Foxtrot",
    "duplicates",
    "decision-qmd-fallback",
    "decision",
  ],
  [
    "q07",
    "What contradicts Golf?",
    "Golf",
    "contradicts",
    "session-review-gauntlet",
    "session",
  ],
  [
    "q08",
    "What mentions Hotel?",
    "Hotel",
    "mentions",
    "thought-hot-memory-defer",
    "thought",
  ],
  [
    "q09",
    "What relates to India?",
    "India",
    "relates_to",
    "decision-nats-gate",
    "decision",
  ],
  [
    "q10",
    "What depends on Juliet?",
    "Juliet",
    "depends_on",
    "session-archive-safety",
    "session",
  ],
  [
    "q11",
    "What is blocked by Kilo?",
    "Kilo",
    "blocked_by",
    "thought-db-owner",
    "thought",
  ],
  [
    "q12",
    "What was implemented by Lima?",
    "Lima",
    "implemented_by",
    "project-docs-site",
    "project",
  ],
  [
    "q13",
    "What was decided by Mike?",
    "Mike",
    "decided_by",
    "decision-python-floor",
    "decision",
  ],
  [
    "q14",
    "What supersedes November?",
    "November",
    "supersedes",
    "thought-redaction-superset",
    "thought",
  ],
  [
    "q15",
    "What duplicates Oscar?",
    "Oscar",
    "duplicates",
    "session-canary-proof",
    "session",
  ],
  [
    "q16",
    "What contradicts Papa?",
    "Papa",
    "contradicts",
    "decision-shared-kb",
    "decision",
  ],
  [
    "q17",
    "What mentions Quebec?",
    "Quebec",
    "mentions",
    "thought-mcp-cache",
    "thought",
  ],
  [
    "q18",
    "What relates to Romeo?",
    "Romeo",
    "relates_to",
    "project-dreamengine",
    "project",
  ],
  [
    "q19",
    "What depends on Sierra?",
    "Sierra",
    "depends_on",
    "session-agent-context",
    "session",
  ],
  [
    "q20",
    "What is blocked by Tango?",
    "Tango",
    "blocked_by",
    "thought-rollback-note",
    "thought",
  ],
] satisfies Array<[string, string, string, string, string, SourceType]>;

export const relationalQuestions: RelationalQuestion[] = relationalQuestionRows.map(
  ([id, question, seed, relation, expected_id, expected_type]) => ({
    id,
    question,
    namespace: "shared-kb",
    seed,
    relation,
    direction: "incoming",
    expected_id,
    expected_type,
  }),
);

export const links: FixtureLink[] = [
  ...relationalQuestions.map((question, index) => ({
    id: `link-${index + 1}`,
    namespace: question.namespace,
    from_type: question.expected_type,
    from_id: question.expected_id,
    to_type: "entity" as const,
    to_id: `entity-${question.seed.toLowerCase()}`,
    relation: question.relation,
  })),
  {
    id: "link-outgoing-alpha",
    namespace: "shared-kb",
    from_type: "entity",
    from_id: "entity-alpha",
    to_type: "decision",
    to_id: "decision-qmd-fallback",
    relation: "depends_on",
  },
  {
    id: "link-private-leak",
    namespace: "private-agent",
    from_type: "thought",
    from_id: "private-leak-target",
    to_type: "entity",
    to_id: "entity-private",
    relation: "mentions",
  },
  {
    id: "link-archived-link",
    namespace: "shared-kb",
    from_type: "thought",
    from_id: "archived-link-target",
    to_type: "entity",
    to_id: "entity-alpha",
    relation: "mentions",
    archived_at: "2026-07-01T00:00:00Z",
  },
  {
    id: "link-archived-entity",
    namespace: "shared-kb",
    from_type: "thought",
    from_id: "archived-entity-target",
    to_type: "entity",
    to_id: "entity-archived",
    relation: "mentions",
  },
];

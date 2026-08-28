// Fixture oracle helpers for the search_brain relational retrieval eval:
// query parsing, the keyword baseline, the graph oracle, and the mock search
// pool. Holds no test and creates no real pool.

import {
  type FixtureEntry,
  type RelationalQuestion,
  entities,
  entries,
  links,
} from "./search-brain-relational-retrieval-fixture-data.ts";

const INCOMING_RELATION_PATTERN =
  /what\s+(?:is\s+)?(?:was\s+)?(?<relation>depends on|blocked by|implemented by|decided by|supersedes|duplicates|contradicts|mentions|relates to)\s+(?<seed>[^?]{1,160})\??$/i;
const OUTGOING_DEPENDS_PATTERN =
  /what\s+does\s+(?<seed>[^?]{1,160})\s+depend\s+on\??$/i;
const OUTGOING_BLOCKED_PATTERN =
  /what\s+(?:is\s+)?(?<seed>[^?]{1,160})\s+blocked\s+by\??$/i;

const relationAliases: Record<string, string> = {
  "depends on": "depends_on",
  "blocked by": "blocked_by",
  "implemented by": "implemented_by",
  "decided by": "decided_by",
  supersedes: "supersedes",
  duplicates: "duplicates",
  contradicts: "contradicts",
  mentions: "mentions",
  "relates to": "relates_to",
};

type ParsedFixtureQuery = {
  relation: string;
  seed: string;
  direction: "incoming" | "outgoing";
};

function parseOutgoingFixtureQuery(query: string): ParsedFixtureQuery | undefined {
  const outgoingDepends = OUTGOING_DEPENDS_PATTERN.exec(query)?.groups;
  if (outgoingDepends?.seed) {
    return {
      relation: "depends_on",
      seed: outgoingDepends.seed,
      direction: "outgoing",
    };
  }

  const outgoingBlocked = OUTGOING_BLOCKED_PATTERN.exec(query)?.groups;
  if (outgoingBlocked?.seed) {
    return {
      relation: "blocked_by",
      seed: outgoingBlocked.seed,
      direction: "outgoing",
    };
  }
  return undefined;
}

export function parseFixtureQuery(query: string): ParsedFixtureQuery | undefined {
  const outgoing = parseOutgoingFixtureQuery(query);
  if (outgoing) return outgoing;

  const incoming = INCOMING_RELATION_PATTERN.exec(query)?.groups;
  if (!incoming?.relation || !incoming.seed) return undefined;
  const relation = relationAliases[incoming.relation.toLowerCase()];
  if (!relation) return undefined;
  return { relation, seed: incoming.seed, direction: "incoming" };
}

const BASELINE_STOPWORDS = new Set([
  "what",
  "is",
  "was",
  "by",
  "on",
  "to",
  "depends",
  "blocked",
  "implemented",
  "decided",
  "supersedes",
  "duplicates",
  "contradicts",
  "mentions",
  "relates",
]);

export function keywordBaseline(
  query: string,
  readableNamespaces = ["shared-kb"],
): FixtureEntry[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !BASELINE_STOPWORDS.has(term));
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      readableNamespaces.includes(entry.namespace) &&
      terms.some((term) => entry.text.toLowerCase().includes(term)),
  );
}

export function graphOracle(
  query: string,
  readableNamespaces = ["shared-kb"],
): FixtureEntry[] {
  const parsed = parseFixtureQuery(query);
  if (!parsed) return keywordBaseline(query, readableNamespaces);
  const seedName = parsed.seed.toLowerCase();
  const seed = entities.find(
    (entity) =>
      !entity.archived_at &&
      readableNamespaces.includes(entity.namespace) &&
      entity.name.toLowerCase() === seedName,
  );
  if (!seed) return [];
  const linkedIds = links
    .filter(
      (link) =>
        !link.archived_at &&
        link.namespace === seed.namespace &&
        readableNamespaces.includes(link.namespace) &&
        link.relation === parsed.relation &&
        (parsed.direction === "incoming"
          ? link.to_type === "entity" && link.to_id === seed.id
          : link.from_type === "entity" && link.from_id === seed.id),
    )
    .map((link) =>
      parsed.direction === "incoming"
        ? `${link.from_type}:${link.from_id}`
        : `${link.to_type}:${link.to_id}`,
    );
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      readableNamespaces.includes(entry.namespace) &&
      linkedIds.includes(`${entry.source_type}:${entry.id}`),
  );
}

export function graphEntriesFor(
  seedName: string,
  relation: string,
  direction: "incoming" | "outgoing",
  readableNamespaces = ["shared-kb"],
): FixtureEntry[] {
  const seed = entities.find(
    (entity) =>
      !entity.archived_at &&
      readableNamespaces.includes(entity.namespace) &&
      entity.name.toLowerCase() === seedName.toLowerCase(),
  );
  if (!seed) return [];
  const linkedIds = links
    .filter(
      (link) =>
        !link.archived_at &&
        link.namespace === seed.namespace &&
        readableNamespaces.includes(link.namespace) &&
        (direction === "incoming"
          ? link.to_type === "entity" && link.to_id === seed.id
          : link.from_type === "entity" && link.from_id === seed.id) &&
        link.relation === relation,
    )
    .map((link) =>
      direction === "incoming"
        ? `${link.from_type}:${link.from_id}`
        : `${link.to_type}:${link.to_id}`,
    );
  return entries.filter(
    (entry) =>
      !entry.archived_at &&
      readableNamespaces.includes(entry.namespace) &&
      linkedIds.includes(`${entry.source_type}:${entry.id}`),
  );
}

export function searchRow(entry: FixtureEntry) {
  return {
    source_type: entry.source_type,
    id: entry.id,
    namespace: entry.namespace,
    content_preview: entry.text,
    tags: [],
    created_by: "test",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tier: "warm",
    usefulness: 0.5,
    access_count: 0,
    fts_rank: 1,
    distance: null,
  };
}

export function namespaceList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : ["shared-kb"];
}

export function graphAwareSearchPool(stats: { graphCalls: number }) {
  return {
    query: async (...args: unknown[]) => {
      const [sql, rawParams] = args;
      const params = (rawParams ?? []) as unknown[];
      const text = String(sql);
      if (text.includes("relational_graph_seed")) {
        stats.graphCalls += 1;
        const direction = text.includes("l.to_type = 'entity'")
          ? "incoming"
          : "outgoing";
        const readableNamespaces = namespaceList(params[3]);
        return {
          rows: graphEntriesFor(
            String(params[0] ?? ""),
            String(params[1] ?? ""),
            direction,
            readableNamespaces,
          ).map(searchRow),
        };
      }
      if (text.includes("FROM ob_links")) return { rows: [] };
      if (text.includes("fts_query")) {
        return {
          rows: keywordBaseline(String(params[0] ?? ""), namespaceList(params[3])).map(
            searchRow,
          ),
        };
      }
      return { rows: [] };
    },
  };
}

export function recall(
  questions: RelationalQuestion[],
  search: (query: string, readableNamespaces?: string[]) => FixtureEntry[],
): number {
  const hits = questions.filter((question) =>
    search(question.question, [question.namespace]).some(
      (entry) => entry.id === question.expected_id,
    ),
  ).length;
  return hits / questions.length;
}

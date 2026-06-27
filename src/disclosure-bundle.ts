export interface DisclosureCitation {
  id: string;
  label: string;
  url?: string;
  path?: string;
  sourceRef?: string;
}

export interface DisclosureEvent {
  id: string;
  type: string;
  content: string;
  timestamp: string;
  sourceRef?: string;
  source_ref?: string;
  artifactPath?: string;
  artifact_path?: string;
  citations?: DisclosureCitation[];
  metadata?: Record<string, unknown>;
}

export interface DisclosureRepoFact {
  id: string;
  subject: string;
  fact: string;
  sourceUrl?: string;
  source_url?: string;
  path?: string;
  citations?: DisclosureCitation[];
  metadata?: Record<string, unknown>;
}

export interface DisclosureReceipt {
  id: string;
  action: string;
  timestamp: string;
  sources?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  validations?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface DisclosureBundleInput {
  lane: {
    sessionKey: string;
    agent?: string;
    project?: string;
    topic?: string;
    metadata?: Record<string, unknown>;
  };
  events?: DisclosureEvent[];
  repoFacts?: DisclosureRepoFact[];
  receipts?: DisclosureReceipt[];
}

export interface DisclosureBundleFile {
  path: string;
  content: string;
}

export interface DisclosureBundle {
  profile: "okf-like";
  files: DisclosureBundleFile[];
}

export function exportDisclosureBundle(input: DisclosureBundleInput): DisclosureBundle {
  const events = [...(input.events ?? [])].sort(byTimestampThenId);
  const facts = [...(input.repoFacts ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const receipts = [...(input.receipts ?? [])].sort(byTimestampThenId);
  const citations = collectCitations(events, facts, receipts);
  const factPaths = conceptPaths(facts);

  return {
    profile: "okf-like",
    files: [
      { path: "index.md", content: renderIndex(input, events, facts, receipts, citations, factPaths) },
      { path: "log.md", content: renderLog(events) },
      ...facts.map((fact, index) => ({
        path: factPaths[index] ?? conceptPath(fact),
        content: renderConcept(fact),
      })),
      { path: "citations.md", content: renderCitations(citations) },
      { path: "receipts.md", content: renderReceipts(receipts) },
    ],
  };
}

function byTimestampThenId(
  left: { timestamp: string; id: string },
  right: { timestamp: string; id: string },
): number {
  if (left.timestamp !== right.timestamp) return left.timestamp.localeCompare(right.timestamp);
  return left.id.localeCompare(right.id);
}

function renderIndex(
  input: DisclosureBundleInput,
  events: DisclosureEvent[],
  facts: DisclosureRepoFact[],
  receipts: DisclosureReceipt[],
  citations: DisclosureCitation[],
  factPaths: string[],
): string {
  const title = input.lane.topic ?? input.lane.sessionKey;
  return [
    frontmatter({
      profile: "okf-like",
      type: "index",
      session_key: input.lane.sessionKey,
      agent: input.lane.agent,
      project: input.lane.project,
      okf: okfMetadata(input.lane.metadata),
    }),
    `# ${title}`,
    "",
    `- Session: ${input.lane.sessionKey}`,
    input.lane.agent ? `- Agent: ${input.lane.agent}` : undefined,
    input.lane.project ? `- Project: ${input.lane.project}` : undefined,
    `- Events: ${events.length}`,
    `- Concepts: ${facts.length}`,
    `- Receipts: ${receipts.length}`,
    `- Citations: ${citations.length}`,
    "",
    "## Files",
    "",
    "- [log.md](log.md)",
    "- [citations.md](citations.md)",
    "- [receipts.md](receipts.md)",
    ...facts.map((fact, index) => `- [${fact.subject}](${factPaths[index] ?? conceptPath(fact)})`),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function conceptPaths(facts: DisclosureRepoFact[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  facts.forEach((fact, index) => {
    let path = conceptPath(fact);
    if (seen.has(path)) {
      path = `concepts/${slug(fact.subject || "concept")}-${slug(fact.id)}.md`;
    }
    while (seen.has(path)) {
      path = `concepts/${slug(fact.subject || "concept")}-${slug(fact.id || "fact")}-${index}.md`;
    }
    seen.add(path);
    paths.push(path);
  });
  return paths;
}

function conceptPath(fact: DisclosureRepoFact): string {
  return `concepts/${slug(fact.subject || fact.id)}.md`;
}

function renderLog(events: DisclosureEvent[]): string {
  return [
    frontmatter({ profile: "okf-like", type: "log" }),
    "# Log",
    "",
    ...events.flatMap((event) => [
      `## ${event.timestamp} ${event.type}`,
      "",
      event.content,
      "",
      ...eventCitationLines(event),
    ]),
  ].join("\n");
}

function renderConcept(fact: DisclosureRepoFact): string {
  return [
    frontmatter({ profile: "okf-like", type: "concept", id: fact.id, okf: okfMetadata(fact.metadata) }),
    `# ${fact.subject}`,
    "",
    fact.fact,
    "",
    "## Citations",
    "",
    ...factCitationLines(fact),
    "",
  ].join("\n");
}

function renderCitations(citations: DisclosureCitation[]): string {
  return [
    frontmatter({ profile: "okf-like", type: "citations" }),
    "# Citations",
    "",
    ...citations.map((citation) => `- ${citation.id}: ${citationLabel(citation)}`),
    "",
  ].join("\n");
}

function renderReceipts(receipts: DisclosureReceipt[]): string {
  return [
    frontmatter({ profile: "okf-like", type: "receipts" }),
    "# Receipts",
    "",
    ...receipts.flatMap((receipt) => [
      `## ${receipt.action}`,
      "",
      `- ID: ${receipt.id}`,
      `- Timestamp: ${receipt.timestamp}`,
      `- Sources: ${stableJson(receipt.sources ?? [])}`,
      `- Outputs: ${stableJson(receipt.outputs ?? [])}`,
      `- Validations: ${stableJson(receipt.validations ?? [])}`,
      "",
    ]),
  ].join("\n");
}

function collectCitations(
  events: DisclosureEvent[],
  facts: DisclosureRepoFact[],
  receipts: DisclosureReceipt[],
): DisclosureCitation[] {
  const citations = new Map<string, DisclosureCitation>();
  for (const event of events) {
    const sourceRef = eventSourceRef(event);
    const artifactPath = eventArtifactPath(event);
    if (sourceRef) addCitation(citations, { id: `event:${event.id}:source`, label: "source_ref", sourceRef });
    if (artifactPath) addCitation(citations, { id: `event:${event.id}:artifact`, label: "artifact_path", path: artifactPath });
    for (const citation of event.citations ?? []) addCitation(citations, citation);
  }
  for (const fact of facts) {
    const sourceUrl = factSourceUrl(fact);
    if (sourceUrl) addCitation(citations, { id: `fact:${fact.id}:source_url`, label: fact.subject, url: sourceUrl });
    if (fact.path) addCitation(citations, { id: `fact:${fact.id}:path`, label: fact.subject, path: fact.path });
    for (const citation of fact.citations ?? []) addCitation(citations, citation);
  }
  for (const receipt of receipts) {
    addCitation(citations, { id: `receipt:${receipt.id}`, label: receipt.action, sourceRef: receipt.id });
  }
  return [...citations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function addCitation(citations: Map<string, DisclosureCitation>, citation: DisclosureCitation): void {
  citations.set(citation.id, citation);
}

function eventCitationLines(event: DisclosureEvent): string[] {
  const lines = [];
  const sourceRef = eventSourceRef(event);
  const artifactPath = eventArtifactPath(event);
  if (sourceRef) lines.push(`- Source ref: ${sourceRef}`);
  if (artifactPath) lines.push(`- Artifact: ${artifactPath}`);
  for (const citation of event.citations ?? []) lines.push(`- Citation: ${citationLabel(citation)}`);
  return lines.length > 0 ? ["### Citations", "", ...lines, ""] : [];
}

function factCitationLines(fact: DisclosureRepoFact): string[] {
  const lines = [];
  const sourceUrl = factSourceUrl(fact);
  if (sourceUrl) lines.push(`- Source URL: ${sourceUrl}`);
  if (fact.path) lines.push(`- Path: ${fact.path}`);
  for (const citation of fact.citations ?? []) lines.push(`- ${citationLabel(citation)}`);
  return lines.length > 0 ? lines : ["- None"];
}

function eventSourceRef(event: DisclosureEvent): string | undefined {
  return event.sourceRef ?? event.source_ref;
}

function eventArtifactPath(event: DisclosureEvent): string | undefined {
  return event.artifactPath ?? event.artifact_path;
}

function factSourceUrl(fact: DisclosureRepoFact): string | undefined {
  return fact.sourceUrl ?? fact.source_url;
}

function citationLabel(citation: DisclosureCitation): string {
  return [citation.label, citation.url, citation.path, citation.sourceRef].filter(Boolean).join(" ");
}

function frontmatter(values: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${stableJson(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function okfMetadata(metadata: Record<string, unknown> | undefined): unknown {
  const okf = metadata?.okf;
  return okf && typeof okf === "object" && !Array.isArray(okf) ? okf : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "concept";
}

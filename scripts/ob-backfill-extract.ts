/**
 * LLM session extraction for ob-backfill (issue 864 L6 seam).
 *
 * Moved verbatim out of scripts/ob-backfill.ts so the entrypoint stays
 * within the repo file-size rule. The prompt, request shape, and parsing
 * are unchanged.
 */

import { createHash } from "crypto";

// No local default -- see scripts/curate.ts for the same rule. A localhost
// fallback silently works on a developer Mac and silently fails in a
// container. Resolved at the CALL site, not at import: a module-level exit
// would take down every test that merely imports this file.
function requireLlmBaseUrl(): string {
  const url = process.env.LLM_BASE_URL;
  if (!url) {
    throw new Error(
      "LLM_BASE_URL is required: point it at the fleet inference endpoint. " +
        "There is no local default.",
    );
  }
  return url;
}
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL ?? "sonnet";

export interface SessionExtract {
  summary: string;
  key_decisions: string[];
  learnings: string[];
  next_steps: string[];
  blockers: string[];
  project: string;
  date?: string;
}

// --- LLM extraction ---

/** What the session was, beyond the transcript text itself. */
export interface SessionContext {
  project: string;
  subagents: string[];
  filesChanged: string[];
  date?: string;
}

/** The header block prepended to the extraction prompt. */
function buildContextParts(context: SessionContext, uniqueHash: string): string {
  const { project, subagents, filesChanged, date } = context;
  return [
    `Project: ${project} [ref:${uniqueHash}]`,
    date ? `Date: ${date}` : "",
    subagents.length > 0
      ? `Subagent work delegated:\n${subagents.map((s) => `- ${s}`).join("\n")}`
      : "",
    filesChanged.length > 0
      ? `Files modified:\n${filesChanged.map((f) => `- ${f}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Reads the model's reply and coerces it into a SessionExtract. */
function parseExtractResponse(raw: string, context: SessionContext): SessionExtract {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? (value as string[]) : [];
  return {
    summary: (parsed.summary as string) ?? "",
    key_decisions: stringList(parsed.key_decisions),
    learnings: stringList(parsed.learnings),
    next_steps: stringList(parsed.next_steps),
    blockers: stringList(parsed.blockers),
    project: context.project,
    date: context.date,
  };
}

export async function extractSession(
  conversation: string,
  context: SessionContext,
): Promise<SessionExtract | null> {
  const uniqueHash = createHash("sha256")
    .update(conversation.slice(0, 200))
    .digest("hex")
    .slice(0, 8);

  const contextParts = buildContextParts(context, uniqueHash);

  const prompt = `You are extracting a structured session summary from a Claude Code transcript.

${contextParts}

Extract:
1. summary: 2-3 paragraph narrative of what was accomplished, why it matters, and what state things ended in. Include specific file names, tool names, and technical details. A future AI agent should understand the session from this summary alone.
2. key_decisions: array of decisions WITH rationale ("Chose X over Y because Z"). Every session has at least one decision — if you can't find explicit ones, infer from the implementation choices.
3. learnings: array of gotchas, patterns, bugs found, or solutions discovered. Include enough context to be useful without the transcript.
4. next_steps: array of specific actionable items mentioned or implied
5. blockers: array of things that stalled progress (empty array if none)

Return JSON only, no markdown fences.

TRANSCRIPT:
${conversation}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = process.env.LLM_API_KEY;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(`${requireLlmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 2048,
        temperature: 0.1,
        caching: false,
      }),
    });

    if (!response.ok) {
      console.error(`  LLM extraction failed: ${response.status}`);
      return null;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return null;

    return parseExtractResponse(raw, context);
  } catch (err) {
    console.error(
      `  Extraction error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

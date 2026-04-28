import type pg from "pg";
import { logger } from "./logger.ts";

const EXTRACTION_TIMEOUT_MS = 8000;

export interface ExtractedMetadata {
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
}

const SYSTEM_PROMPT = `Extract metadata from the text. Return JSON only, no markdown fences.
{"topics":["1-5 key topics"],"people":["mentioned names"],"action_items":["tasks if any"],"dates":["YYYY-MM-DD if any"]}
Return empty arrays for categories with no matches. Be concise.`;

export async function extractMetadata(
  text: string,
  litellmUrl?: string,
): Promise<ExtractedMetadata | null> {
  if (!text || text.length < 10) return null;

  const baseUrl = litellmUrl ?? process.env.LITELLM_URL;
  const model = process.env.EXTRACTION_MODEL ?? "sonnet";
  if (!baseUrl) {
    logger.warn("No LiteLLM URL configured for extraction");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = process.env.LITELLM_API_KEY;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 4000) },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1024,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("Extraction request failed", { status: response.status });
      return null;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = json.choices?.[0]?.message?.content;
    if (!raw) {
      logger.warn("Extraction returned empty content");
      return null;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      topics: Array.isArray(parsed.topics) ? (parsed.topics as string[]) : [],
      people: Array.isArray(parsed.people) ? (parsed.people as string[]) : [],
      action_items: Array.isArray(parsed.action_items)
        ? (parsed.action_items as string[])
        : [],
      dates: Array.isArray(parsed.dates) ? (parsed.dates as string[]) : [],
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      logger.warn("Extraction returned invalid JSON");
    } else {
      logger.warn("Extraction error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Merge extracted topics and people into existing tags array.
 * People are prefixed with "person:" for filtering.
 * Deduplicates against existing tags (case-insensitive).
 */
export function mergeTags(
  existingTags: string[],
  extracted: ExtractedMetadata | null,
): string[] {
  if (!extracted) return existingTags;

  const seen = new Set(existingTags.map((t) => t.toLowerCase()));
  const merged = [...existingTags];

  for (const topic of extracted.topics) {
    const key = topic.toLowerCase();
    if (!seen.has(key)) {
      merged.push(topic);
      seen.add(key);
    }
  }

  for (const person of extracted.people) {
    const tagged = `person:${person}`;
    const key = tagged.toLowerCase();
    if (!seen.has(key)) {
      merged.push(tagged);
      seen.add(key);
    }
  }

  return merged;
}

/**
 * Fire-and-forget background extraction: fetch metadata, merge tags, update DB.
 * Shared by log-thought and log-decision to avoid duplicated extraction blocks.
 */
export function backgroundExtract(
  pool: pg.Pool,
  table: string,
  entryId: string,
  text: string,
  existingTags: string[],
): void {
  extractMetadata(text)
    .then((extracted) => {
      if (!extracted) return;
      const enrichedTags = mergeTags(existingTags, extracted);
      pool
        .query(
          `UPDATE ${table} SET tags = $1, extracted_metadata = $2 WHERE id = $3`,
          [enrichedTags, JSON.stringify(extracted), entryId],
        )
        .catch((err: unknown) => {
          logger.warn("extraction_update_error", {
            table,
            id: entryId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    })
    .catch((err) =>
      logger.warn("extraction_background_error", {
        table,
        id: entryId,
        error: String(err),
      }),
    );
}

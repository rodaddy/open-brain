import { createHash } from "node:crypto";
import { logger } from "./logger.ts";

const EMBEDDING_TIMEOUT_MS = 5000;

export async function generateEmbedding(
  text: string,
  litellmUrl?: string,
): Promise<number[] | null> {
  if (!text || text.length > 32000) {
    logger.warn("Embedding text empty or too long", {
      length: text?.length ?? 0,
    });
    return null;
  }

  const baseUrl = litellmUrl ?? process.env.LITELLM_URL;
  if (!baseUrl) {
    logger.warn("No LiteLLM URL configured");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "embeddings",
        input: text,
        dimensions: 768,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LiteLLM embedding request failed", {
        status: response.status,
      });
      return null;
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };

    const embedding = json.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.length !== 768) {
      logger.warn("LiteLLM returned malformed embedding", {
        hasData: !!json.data,
        length: Array.isArray(embedding) ? embedding.length : "not-array",
      });
      return null;
    }

    return embedding as number[];
  } catch (err) {
    logger.warn("LiteLLM embedding error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function contentHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

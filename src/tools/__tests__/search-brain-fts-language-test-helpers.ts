import { Pool } from "pg";
import { createMockEmbed } from "./test-helpers.ts";
/**
 * Fail loudly on a non-UTF8 test harness. Under SQL_ASCII (or any non-UTF8
 * encoding) the snowball stemmers split the multibyte bytes of accented
 * characters (ä -> two single-byte chars), so "Häuser" never stems to "haus"
 * and every non-english ranking assertion below returns []. That looks like a
 * product bug but is purely an invalid harness -- Open Brain is UTF8 in
 * production. This turns the confusing empty-ranking failure into a clear
 * "test DB must be UTF8" signal. See .github/workflows/ci.yml (`createdb
 * -E UTF8 -T template0`).
 */
export async function assertUtf8Harness(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ server_encoding: string }>(
    "SHOW server_encoding",
  );
  const encoding = rows[0]?.server_encoding;
  if (encoding !== "UTF8") {
    throw new Error(
      `language-aware FTS tests require a UTF8 test database; server_encoding is ` +
        `${encoding ?? "unknown"}. Snowball stemming of accented multibyte text ` +
        `is broken under non-UTF8 encodings. Recreate the DB with ` +
        `\`createdb -E UTF8 -T template0\`.`,
    );
  }
}

// Vector arm is irrelevant here; force keyword mode so we isolate the lexical
// FTS config behavior deterministically.
export const embed = createMockEmbed(null);
export const THOUGHTS_ONLY: "thoughts"[] = ["thoughts"];

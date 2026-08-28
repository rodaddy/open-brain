/**
 * Database-error and transcript-citation coverage for `append_session_event`,
 * split out of append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { getErrorText, parseToolResult } from "./test-helpers.ts";
import { setupToolClient } from "./append-session-event-test-helpers.ts";

async function reportsDatabaseErrorWithMessage() {
  const mockPool = {
    query: async () => {
      throw new Error("connection refused");
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "DB will crash",
      },
    });

    expect(result.isError).toBe(true);
    expect(getErrorText(result)).toContain("connection refused");
    expect(getErrorText(result)).toContain("Database error");
  } finally {
    await cleanup();
  }
}

async function persistsHostNeutralTranscriptCitation() {
  let insertParams: unknown[] | undefined;
  const mockPool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [{ id: "lane-uuid-1", status: "active" }] };
      }
      insertParams = params;
      return {
        rows: [{ id: "event-uuid-1", created_at: "2026-07-13T12:00:00Z" }],
      };
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "capture:288",
        event_type: "decision",
        content: "Use durable transcript citations.",
        source: "rico",
        transcript_ref: "collab/open-brain/conversations/288",
        transcript: "Rico: preserve the source conversation with the decision.",
        occurred_at: "2026-07-13T11:59:00Z",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(parseToolResult(result).transcript_ref).toBe(
      "collab/open-brain/conversations/288",
    );
    expect(insertParams?.slice(5, 8)).toEqual([
      "collab/open-brain/conversations/288",
      "Rico: preserve the source conversation with the decision.",
      "2026-07-13T11:59:00Z",
    ]);
  } finally {
    await cleanup();
  }
}

async function rejectsHostSpecificTranscriptReferences() {
  let queryCount = 0;
  const mockPool = {
    query: async () => {
      queryCount += 1;
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "capture:288",
        event_type: "decision",
        content: "This must not write.",
        transcript_ref: "/var/lib/open-brain/transcripts/288.jsonl",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result);
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.message).toContain("canonical host-neutral collab");
    expect(queryCount).toBe(0);
  } finally {
    await cleanup();
  }
}

async function requiresRefForEmptyTranscript() {
  let queryCount = 0;
  const mockPool = {
    query: async () => {
      queryCount += 1;
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const emptyTranscript = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "capture:288",
        event_type: "decision",
        content: "This must not write.",
        transcript: "",
      },
    });
    const noncanonicalRef = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "capture:288",
        event_type: "decision",
        content: "This also must not write.",
        transcript_ref: "collab/open-brain/../conversations",
      },
    });

    expect(parseToolResult(emptyTranscript).message).toContain(
      "transcript_ref is required",
    );
    expect(parseToolResult(noncanonicalRef).message).toContain(
      "canonical host-neutral",
    );
    expect(emptyTranscript.isError).toBe(true);
    expect(noncanonicalRef.isError).toBe(true);
    expect(queryCount).toBe(0);
  } finally {
    await cleanup();
  }
}

async function rejectsCredentialLikeTranscriptMaterial() {
  let queryCount = 0;
  const mockPool = {
    query: async () => {
      queryCount += 1;
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);
  const syntheticCredential = ["api", "key"].join("_") + ": synthetic-value";

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "capture:288",
        event_type: "decision",
        content: "This fact is safe, but its source exchange is not.",
        transcript_ref: "collab/open-brain/conversations/288",
        transcript: `Rico: ${syntheticCredential}`,
      },
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).message).toContain("credential-like material");
    expect(queryCount).toBe(0);
  } finally {
    await cleanup();
  }
}

async function reportsDuplicateCannotRetainCitation() {
  const mockPool = {
    query: async (sql: string) => {
      if (sql.includes("ob_session_lanes")) {
        return { rows: [{ id: "lane-uuid-1", status: "active" }] };
      }
      if (sql.includes("citation_matches")) {
        return {
          rows: [{ id: "existing-event-uuid", citation_matches: false }],
        };
      }
      return { rows: [] };
    },
  };
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "capture:288",
        event_type: "decision",
        content: "A deduplicated fact.",
        transcript_ref: "collab/open-brain/conversations/288",
        transcript: "Rico: cite this exchange.",
      },
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toMatchObject({
      error: "citation_not_stored",
      duplicate: true,
      existing_event_id: "existing-event-uuid",
    });
  } finally {
    await cleanup();
  }
}

describe("append_session_event database errors and transcript citation", () => {
  it(
    "returns isError=true with message when DB query throws",
    reportsDatabaseErrorWithMessage,
  );
  it(
    "persists a host-neutral transcript citation with the event",
    persistsHostNeutralTranscriptCitation,
  );
  it(
    "rejects host-specific transcript references before any database write",
    rejectsHostSpecificTranscriptReferences,
  );
  it(
    "requires transcript_ref for an empty transcript and rejects noncanonical segments",
    requiresRefForEmptyTranscript,
  );
  it(
    "rejects credential-like transcript material before any database write",
    rejectsCredentialLikeTranscriptMaterial,
  );
  it(
    "reports when a duplicate cannot retain newly supplied citation fields",
    reportsDuplicateCannotRetainCitation,
  );
});

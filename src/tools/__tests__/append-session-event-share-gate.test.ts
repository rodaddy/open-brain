/**
 * Sync share-nomination gate coverage for `append_session_event`, split out of
 * append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { parseToolResult } from "./test-helpers.ts";
import {
  setupToolClient,
  createCapturingPool,
  expectDefined,
} from "./append-session-event-test-helpers.ts";

// ── SYNC SHARE-NOMINATION GATE (Issue #161, Q1) ──
// adjudicateNominationSync runs inline on the write path: a share_candidate
// carrying a secret or person-private content is hard-rejected, the nomination
// flag is STRIPPED before persist (so the async promoter never sweeps it), a
// share_rejected_sync marker is stamped on the persisted metadata, and the
// tool response surfaces share_candidate_rejected. Clean/absent nominations
// pass through untouched. The shared promoter only sweeps explicit
// memory_lifecycle_action=nominate_shared rows, not candidate presence alone.
//
// We assert the persisted metadata by capturing the INSERT params on the mock
// pool. The metadata is the 7th INSERT param ($7, index 6), JSON.stringify'd.

async function stripsShareCandidateAndReportsRejectSecretWhenContentCarries(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        // Substantive content that also embeds an OpenAI-style key.
        content: "Configured the deploy pipeline with key " + "sk-" + "a".repeat(20),
        metadata: { share_candidate: true },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      span_count: 1,
      resubmittable: true,
      resubmit_attempt: 0,
      max_resubmit_attempts: 2,
      resubmit_metadata: {
        sanitized_resubmit_of: "event-uuid-1",
        sanitized_resubmit_attempt: 1,
      },
    });
    expect(JSON.stringify(parsed.reject_detail)).not.toContain("sk-");
    expect(parsed.reject_detail.redaction_hint).toContain("Remove the credential");

    // Persisted metadata: nomination stripped, audit marker stamped.
    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .memory_lifecycle_action,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBe("reject-secret");
  } finally {
    await cleanup();
  }
}

async function treatsStringTrueNominationLikeBooleanTrueMatchesAsyncSqlTrut(): Promise<void> {
  // The async promoter nominates on `metadata->>'share_candidate' = 'true'`,
  // which matches a JSON string "true". If the sync gate only accepted boolean
  // true, a mistyped nomination would skip the inline secret check yet still
  // be swept async — voiding this gate. Regression for that bypass.
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Configured the deploy pipeline with key " + "sk-" + "a".repeat(20),
        metadata: { share_candidate: "true" },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmittable: true,
      resubmit_metadata: {
        sanitized_resubmit_of: "event-uuid-1",
        sanitized_resubmit_attempt: 1,
      },
    });
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .memory_lifecycle_action,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBe("reject-secret");
  } finally {
    await cleanup();
  }
}

async function stripsShareCandidateAndReportsRejectPrivateWhenMetadataPriva(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        // Clean, substantive content — only the private marker triggers reject.
        content: "This is a substantive personal note about my own plans.",
        metadata: { share_candidate: true, private: true },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-private");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-private",
      matched_kind: "private-flag",
      span_count: 1,
      resubmittable: true,
      resubmit_metadata: {
        sanitized_resubmit_of: "event-uuid-1",
        sanitized_resubmit_attempt: 1,
      },
    });

    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .memory_lifecycle_action,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBe("reject-private");
    // The original private marker is preserved (only share_candidate stripped).
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata").private,
    ).toBe(true);
  } finally {
    await cleanup();
  }
}

async function marksRepeatedRejectedSanitizedResubmitsNonResubmittableAtThe(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);
  const fakeKey = "sk" + "-" + "a".repeat(20);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: `Sanitized resend still accidentally carries ${fakeKey}`,
        metadata: {
          share_candidate: true,
          sanitized_resubmit_of: "event-original",
          sanitized_resubmit_attempt: 2,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmittable: false,
      resubmit_attempt: 2,
      max_resubmit_attempts: 2,
      resubmit_blocked_reason: "max_attempts",
    });
    expect(parsed.reject_detail.resubmit_metadata).toBeUndefined();
    expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
  } finally {
    await cleanup();
  }
}

async function doesNotTrustAResetSanitizedResubmitAttemptWhenPriorRejectedR(): Promise<void> {
  const mockPool = createCapturingPool(1);
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);
  const fakeKey = "sk" + "-" + "a".repeat(20);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: `Reset resend still accidentally carries ${fakeKey}`,
        metadata: {
          share_candidate: true,
          sanitized_resubmit_of: "event-original",
          sanitized_resubmit_attempt: 0,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmittable: false,
      resubmit_attempt: 2,
      max_resubmit_attempts: 2,
      resubmit_blocked_reason: "max_attempts",
    });
    expect(parsed.reject_detail.resubmit_metadata).toBeUndefined();
    expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
  } finally {
    await cleanup();
  }
}

async function keepsTheOriginalRejectionRootWhenAContractFollowingResubmitF(): Promise<void> {
  const mockPool = createCapturingPool(0);
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);
  const fakeKey = "sk" + "-" + "a".repeat(20);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: `First sanitized retry still accidentally carries ${fakeKey}`,
        metadata: {
          share_candidate: true,
          sanitized_resubmit_of: "event-original",
          sanitized_resubmit_attempt: 1,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmittable: true,
      resubmit_attempt: 1,
      max_resubmit_attempts: 2,
      resubmit_metadata: {
        sanitized_resubmit_of: "event-original",
        sanitized_resubmit_attempt: 2,
      },
    });
    expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
  } finally {
    await cleanup();
  }
}

async function doesNotLetARotatedResubmitRootResetTheRetryBound(): Promise<void> {
  const mockPool = createCapturingPool(0, 0);
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);
  const fakeKey = "sk" + "-" + "a".repeat(20);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: `Rotated-root resend still accidentally carries ${fakeKey}`,
        metadata: {
          share_candidate: true,
          sanitized_resubmit_of: "event-resubmit-1",
          sanitized_resubmit_attempt: 0,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmittable: false,
      resubmit_attempt: 2,
      max_resubmit_attempts: 2,
      resubmit_blocked_reason: "invalid_resubmit_root",
    });
    expect(parsed.reject_detail.resubmit_metadata).toBeUndefined();
    expect(parsed.reject_detail.redaction_hint).toContain(
      "resend root was not recognized",
    );
    expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
  } finally {
    await cleanup();
  }
}

async function boundsRepeatedRejectedNominationsEvenWhenClientsOmitResubmit(): Promise<void> {
  const mockPool = createCapturingPool(0, 1, 2);
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);
  const fakeKey = "sk" + "-" + "a".repeat(20);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: `Unlineaged retry still accidentally carries ${fakeKey}`,
        metadata: { share_candidate: true },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
    expect(parsed.reject_detail).toMatchObject({
      category: "reject-secret",
      matched_kind: "openai_api_key",
      resubmittable: false,
      resubmit_attempt: 2,
      max_resubmit_attempts: 2,
      resubmit_blocked_reason: "max_attempts",
    });
    expect(parsed.reject_detail.resubmit_metadata).toBeUndefined();
    expect(JSON.stringify(parsed.reject_detail)).not.toContain(fakeKey);
  } finally {
    await cleanup();
  }
}

async function keepsCleanShareCandidateMetadataWithoutMakingCandidatePresen(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content:
          "Chose pgvector halfvec(768) for the embedding column to halve storage.",
        metadata: { share_candidate: true },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    // No sync rejection — the sync gate ONLY hard-rejects secret/private.
    expect(parsed.share_candidate_rejected).toBeUndefined();

    // The marker survives as event metadata. Without the explicit
    // memory_lifecycle_action=nominate_shared action, the shared promoter
    // must treat this as inert candidate state.
    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBe(true);
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .memory_lifecycle_action,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBeUndefined();
  } finally {
    await cleanup();
  }
}

describe("append_session_event share-nomination gate", () => {
  it(
    "strips share_candidate and reports reject-secret when content carries a secret",
    stripsShareCandidateAndReportsRejectSecretWhenContentCarries,
  );
  it(
    'treats string "true" nomination like boolean true (matches async SQL truthiness)',
    treatsStringTrueNominationLikeBooleanTrueMatchesAsyncSqlTrut,
  );
  it(
    "strips share_candidate and reports reject-private when metadata.private is true",
    stripsShareCandidateAndReportsRejectPrivateWhenMetadataPriva,
  );
  it(
    "marks repeated rejected sanitized resubmits non-resubmittable at the bound",
    marksRepeatedRejectedSanitizedResubmitsNonResubmittableAtThe,
  );
  it(
    "does not trust a reset sanitized_resubmit_attempt when prior rejected resubmits exist",
    doesNotTrustAResetSanitizedResubmitAttemptWhenPriorRejectedR,
  );
  it(
    "keeps the original rejection root when a contract-following resubmit fails again",
    keepsTheOriginalRejectionRootWhenAContractFollowingResubmitF,
  );
  it(
    "does not let a rotated resubmit root reset the retry bound",
    doesNotLetARotatedResubmitRootResetTheRetryBound,
  );
  it(
    "bounds repeated rejected nominations even when clients omit resubmit lineage",
    boundsRepeatedRejectedNominationsEvenWhenClientsOmitResubmit,
  );
  it(
    "keeps clean share_candidate metadata without making candidate presence a write",
    keepsCleanShareCandidateMetadataWithoutMakingCandidatePresen,
  );
});

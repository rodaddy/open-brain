/**
 * Share-nomination lifecycle coverage for `append_session_event`, split out of
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

async function preservesAnExplicitSharedNominationLifecycleActionForTheProm(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Chose explicit nomination workflow before shared-kb promotion.",
        metadata: {
          share_candidate: true,
          memory_lifecycle_action: "nominate_shared",
          candidate_type: "shared_kb_nomination",
          candidate_reason: "Reviewed fact is safe to nominate for shared-kb.",
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBeUndefined();
    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBe(true);
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .memory_lifecycle_action,
    ).toBe("nominate_shared");
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .candidate_type,
    ).toBe("shared_kb_nomination");
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .candidate_reason,
    ).toBe("Reviewed fact is safe to nominate for shared-kb.");
  } finally {
    await cleanup();
  }
}

async function stripsLifecycleCandidateMetadataFromRejectedSharedNomination(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Secret nomination contains key " + "sk-" + "b".repeat(20),
        metadata: {
          share_candidate: true,
          memory_lifecycle_action: "nominate_shared",
          candidate_type: "shared_kb_nomination",
          candidate_reason: "Candidate must be rejected before promotion.",
          candidate_confidence: 0.9,
          candidate_scope: { repo: "rodaddy/open-brain" },
          candidate_staleness_policy: "revalidate before sharing",
          evidence_refs: [{ issue: 224 }],
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBe("reject-secret");
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
        .candidate_type,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .candidate_reason,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .candidate_confidence,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .candidate_scope,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .candidate_staleness_policy,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .evidence_refs,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBe("reject-secret");
  } finally {
    await cleanup();
  }
}

async function rejectsMalformedLifecycleMetadataBeforePersistence(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Malformed lifecycle candidate should not persist.",
        metadata: {
          memory_lifecycle_action: "candidate",
          candidate_type: "negative_example",
        },
      },
    });

    expect(result.isError).toBe(true);
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.message).toContain("candidate_reason");
    expect(mockPool.captured.metadata).toBeNull();
  } finally {
    await cleanup();
  }
}

async function rejectsLifecycleEvidenceRefsThatContainSecrets(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Candidate metadata evidence must be citation-safe.",
        metadata: {
          memory_lifecycle_action: "candidate",
          candidate_type: "negative_example",
          candidate_reason: "Evidence refs should not persist secrets.",
          evidence_refs: [{ note: "token=" + "sk-" + "c".repeat(20) }],
        },
      },
    });

    expect(result.isError).toBe(true);
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.message).toContain("evidence_refs");
    expect(mockPool.captured.metadata).toBeNull();
  } finally {
    await cleanup();
  }
}

async function rejectsShareCandidateOnNonNominationLifecycleActions(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Candidate-only state must not also enter the shared queue.",
        metadata: {
          share_candidate: true,
          memory_lifecycle_action: "candidate",
          candidate_type: "negative_example",
          candidate_reason: "Candidate-only correction.",
        },
      },
    });

    expect(result.isError).toBe(true);
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.error).toBe("scope_validation");
    expect(parsed.message).toContain("nominate_shared");
    expect(mockPool.captured.metadata).toBeNull();
  } finally {
    await cleanup();
  }
}

async function acceptsACleanSanitizedResubmitWithoutEmittingRejectionDetail(): Promise<void> {
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
          "Replaced the credential-bearing deployment note with a sanitized operational summary.",
        metadata: {
          share_candidate: true,
          sanitized_resubmit_of: "event-original",
          sanitized_resubmit_attempt: 1,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBeUndefined();
    expect(parsed.reject_detail).toBeUndefined();

    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBe(true);
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .sanitized_resubmit_of,
    ).toBe("event-original");
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .sanitized_resubmit_attempt,
    ).toBe(1);
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBeUndefined();
    expect(mockPool.captured.resubmitQueryCount).toBe(0);
  } finally {
    await cleanup();
  }
}

async function passesMetadataThroughUnchangedWhenNoShareCandidateIsPresent(): Promise<void> {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        // Content that WOULD be a secret, but with no nomination the sync gate
        // must not run — share_rejected_sync must never appear.
        content: "password: hunter2something nominated nowhere",
        metadata: { pr: 42 },
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = expectDefined(parseToolResult(result), "parsed");
    expect(parsed.share_candidate_rejected).toBeUndefined();

    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata").pr,
    ).toBe(42);
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_candidate,
    ).toBeUndefined();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .share_rejected_sync,
    ).toBeUndefined();
  } finally {
    await cleanup();
  }
}

describe("append_session_event share-nomination lifecycle", () => {
  it(
    "preserves an explicit shared nomination lifecycle action for the promoter",
    preservesAnExplicitSharedNominationLifecycleActionForTheProm,
  );
  it(
    "strips lifecycle candidate metadata from rejected shared nominations",
    stripsLifecycleCandidateMetadataFromRejectedSharedNomination,
  );
  it(
    "rejects malformed lifecycle metadata before persistence",
    rejectsMalformedLifecycleMetadataBeforePersistence,
  );
  it(
    "rejects lifecycle evidence refs that contain secrets",
    rejectsLifecycleEvidenceRefsThatContainSecrets,
  );
  it(
    "rejects share_candidate on non-nomination lifecycle actions",
    rejectsShareCandidateOnNonNominationLifecycleActions,
  );
  it(
    "accepts a clean sanitized resubmit without emitting rejection detail",
    acceptsACleanSanitizedResubmitWithoutEmittingRejectionDetail,
  );
  it(
    "passes metadata through unchanged when no share_candidate is present",
    passesMetadataThroughUnchangedWhenNoShareCandidateIsPresent,
  );
});

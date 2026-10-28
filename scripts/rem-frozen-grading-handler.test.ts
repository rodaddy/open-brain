import { beforeEach, describe, expect, test, vi } from "vitest";

const loadFrozenCohort = vi.hoisted(() => vi.fn());
const loadFrozenHumanLabels = vi.hoisted(() => vi.fn());
const submitFrozenHumanLabels = vi.hoisted(() => vi.fn());
vi.mock("./rem-ethereal-cohort.ts", () => ({ loadFrozenCohort }));
vi.mock("./rem-frozen-label-read.ts", () => ({ loadFrozenHumanLabels }));
vi.mock("./rem-frozen-label-store.ts", () => ({ submitFrozenHumanLabels }));

import { createFrozenReviewHandler } from "./rem-frozen-grading-handler.ts";

const sha = "a".repeat(64);
const maxBodyBytes = 1024 * 1024;
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const candidate = (id: string, content: string) => ({
  id,
  namespace: "frozen-ns",
  candidate_type: "decision",
  content,
  content_hash: `hash-${id}`,
  uncertain: true,
  uncertainty_reason: "hidden reason",
  model: "hidden model",
  session_count: 2,
  occurrence_count: 3,
  reinforcement_count: 1,
});
const cohort = {
  schema: "dream_run_001",
  namespace: "frozen-ns",
  digest: "digest",
  fullSnapshotSha256: sha,
  candidates: [candidate(firstId, "first"), candidate(secondId, "second")],
};
const options = {
  pool: {} as never,
  schema: "dream_run_001",
  namespace: "frozen-ns",
  gradedBy: "dana",
};

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "127.0.0.1:3417");
  return new Request(`http://127.0.0.1:3417${path}`, { ...init, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadFrozenCohort.mockResolvedValue(cohort);
  loadFrozenHumanLabels.mockResolvedValue({
    status: "labels_loaded",
    schema: cohort.schema,
    namespace: cohort.namespace,
    cohortDigest: cohort.digest,
    fullSnapshotSha256: sha,
    labels: [{ candidate_id: firstId }],
  });
  submitFrozenHumanLabels.mockResolvedValue({ savedCount: 1 });
});

describe("createFrozenReviewHandler", () => {
  test("renders a blind page bound to the verified full snapshot", async () => {
    const response = await createFrozenReviewHandler(options)(request("/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`const BLIND_MODE = true`);
    expect(html).toContain(`const SNAPSHOT_SHA256 = "${sha}"`);
  });

  test("returns only unlabeled blind queue items and applies an explicit limit", async () => {
    const response = await createFrozenReviewHandler(options)(
      request("/api/queue?limit=1"),
    );
    const body = (await response.json()) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: secondId, content: "second" });
    expect(body.items[0]).not.toHaveProperty("model");
    expect(body.items[0]).not.toHaveProperty("uncertainty_reason");
  });

  test("binds strict batch input to trusted scope and submitted snapshot", async () => {
    const response = await createFrozenReviewHandler(options)(
      request("/api/grade-batch", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3417",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          snapshotSha256: sha,
          grades: [{ candidateId: secondId, action: "promoted", note: "keep" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(submitFrozenHumanLabels).toHaveBeenCalledWith(options.pool, {
      schema: options.schema,
      namespace: options.namespace,
      gradedBy: options.gradedBy,
      expectedSnapshotSha256: sha,
      labels: [{ candidate_id: secondId, grade: "promoted", note: "keep" }],
    });
  });

  test("accepts a valid JSON body one byte below the frozen POST limit", async () => {
    const base = { id: secondId, action: "promoted", snapshotSha256: sha, note: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const body = JSON.stringify({
      ...base,
      note: "x".repeat(maxBodyBytes - overhead - 1),
    });
    expect(new TextEncoder().encode(body)).toHaveLength(maxBodyBytes - 1);

    const response = await createFrozenReviewHandler(options)(
      request("/api/grade", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3417",
          "content-type": "application/json",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(submitFrozenHumanLabels).toHaveBeenCalledOnce();
  });
});

describe("createFrozenReviewHandler rejection boundaries", () => {
  test("rejects an oversized streamed body without Content-Length before storage", async () => {
    const oversized = "x".repeat(maxBodyBytes + 1);
    const oversizedRequest = request("/api/grade", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3417", "content-type": "application/json" },
      body: oversized,
    });
    expect(oversizedRequest.headers.has("content-length")).toBe(false);

    const response = await createFrozenReviewHandler(options)(oversizedRequest);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body exceeds 1 MiB" });
    expect(submitFrozenHumanLabels).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON as a bad request", async () => {
    const response = await createFrozenReviewHandler(options)(
      request("/api/grade", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3417",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body must be valid JSON" });
    expect(submitFrozenHumanLabels).not.toHaveBeenCalled();
  });

  test.each([
    ["caller scope", { namespace: "attacker" }],
    ["nonnull legacy label", { reasonCode: "unsupported" }],
  ])("rejects %s fields without writing", async (_name, extra) => {
    const response = await createFrozenReviewHandler(options)(
      request("/api/grade", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3417",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: secondId,
          action: "rejected",
          snapshotSha256: sha,
          ...extra,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(submitFrozenHumanLabels).not.toHaveBeenCalled();
  });

  test.each([
    ["mismatched host", request("/api/queue", { headers: { host: "localhost:3417" } })],
    [
      "cross-origin post",
      request("/api/grade", {
        method: "POST",
        headers: { origin: "http://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ id: secondId, action: "rejected", snapshotSha256: sha }),
      }),
    ],
  ])("rejects %s before helper I/O", async (_name, unsafeRequest) => {
    const response = await createFrozenReviewHandler(options)(unsafeRequest);

    expect(response.status).toBe(403);
    expect(loadFrozenCohort).not.toHaveBeenCalled();
    expect(loadFrozenHumanLabels).not.toHaveBeenCalled();
    expect(submitFrozenHumanLabels).not.toHaveBeenCalled();
  });

  test("rejects out-of-range limits and unrelated public routes", async () => {
    const handler = createFrozenReviewHandler(options);
    expect((await handler(request("/api/queue?limit=51"))).status).toBe(400);
    expect((await handler(request("/api/history"))).status).toBe(404);
    expect(loadFrozenCohort).not.toHaveBeenCalled();
  });
});

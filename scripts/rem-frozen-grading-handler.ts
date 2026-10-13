import type { Pool } from "pg";
import { z } from "zod";

import { createGradingPageHtml } from "../server/domain/grading-page/index.ts";
import { REVIEW_ACTIONS } from "../server/domain/candidate-review/index.ts";
import { loadFrozenCohort } from "./rem-ethereal-cohort.ts";
import { loadFrozenHumanLabels } from "./rem-frozen-label-read.ts";
import { submitFrozenHumanLabels } from "./rem-frozen-label-store.ts";
import { toFrozenQueueItem } from "./rem-frozen-queue-item.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const legacyFields = {
  reasonCode: z.null().optional(),
  agentBehavior: z.null().optional(),
};
const singleGradeSchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(REVIEW_ACTIONS),
    note: z.string().optional(),
    snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
    ...legacyFields,
  })
  .strict();
const batchGradeSchema = z
  .object({
    snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
    grades: z
      .array(
        z
          .object({
            candidateId: z.string().uuid(),
            action: z.enum(REVIEW_ACTIONS),
            note: z.string().optional(),
            ...legacyFields,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export interface FrozenGradingHandlerOptions {
  pool: Pool;
  schema: string;
  namespace: string;
  gradedBy: string;
}

class HttpInputError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function trustedOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!LOOPBACK_HOSTS.has(url.hostname) || host === null) {
    throw new HttpInputError("invalid loopback host", 403);
  }
  let hostUrl: URL;
  try {
    hostUrl = new URL(`${url.protocol}//${host}`);
  } catch {
    throw new HttpInputError("invalid loopback host", 403);
  }
  if (!LOOPBACK_HOSTS.has(hostUrl.hostname) || hostUrl.host !== url.host) {
    throw new HttpInputError("invalid loopback host", 403);
  }
  return url.origin;
}

function requirePostOrigin(request: Request, origin: string): void {
  if (request.headers.get("origin") !== origin) {
    throw new HttpInputError("invalid origin", 403);
  }
}

function queueLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  if (!/^[0-9]+$/.test(raw)) throw new HttpInputError("invalid limit", 400);
  const limit = Number(raw);
  if (limit < 1 || limit > 50) throw new HttpInputError("invalid limit", 400);
  return limit;
}

async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpInputError("body must be valid JSON", 400);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new HttpInputError("request body exceeds 1 MiB", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpInputError("body must be valid JSON", 400);
  }
}

function labelsFromSingle(body: z.infer<typeof singleGradeSchema>) {
  return [
    {
      candidate_id: body.id,
      grade: body.action,
      ...(body.note === undefined ? {} : { note: body.note }),
    },
  ];
}

function labelsFromBatch(body: z.infer<typeof batchGradeSchema>) {
  return body.grades.map((grade) => ({
    candidate_id: grade.candidateId,
    grade: grade.action,
    ...(grade.note === undefined ? {} : { note: grade.note }),
  }));
}

async function dispatchFrozenRequest(
  options: FrozenGradingHandlerOptions,
  request: Request,
  url: URL,
  origin: string,
): Promise<Response> {
  if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
    const cohort = await loadFrozenCohort(
      options.pool,
      options.schema,
      options.namespace,
    );
    return new Response(
      createGradingPageHtml({ blind: true, snapshotSha256: cohort.fullSnapshotSha256 }),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (request.method === "GET" && url.pathname === "/api/queue") {
    const limit = queueLimit(url);
    const [cohort, loaded] = await Promise.all([
      loadFrozenCohort(options.pool, options.schema, options.namespace),
      loadFrozenHumanLabels(options.pool, options.schema, options.namespace),
    ]);
    const labeled = new Set(loaded.labels.map((label) => label.candidate_id));
    const available = cohort.candidates.filter(
      (candidate) => !labeled.has(candidate.id),
    );
    return json({
      items: available.slice(0, limit).map(toFrozenQueueItem),
      total: available.length,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/grade") {
    requirePostOrigin(request, origin);
    const body = singleGradeSchema.parse(await readJson(request));
    const result = await submitFrozenHumanLabels(options.pool, {
      schema: options.schema,
      namespace: options.namespace,
      gradedBy: options.gradedBy,
      expectedSnapshotSha256: body.snapshotSha256,
      labels: labelsFromSingle(body),
    });
    return json(result);
  }
  if (request.method === "POST" && url.pathname === "/api/grade-batch") {
    requirePostOrigin(request, origin);
    const body = batchGradeSchema.parse(await readJson(request));
    const result = await submitFrozenHumanLabels(options.pool, {
      schema: options.schema,
      namespace: options.namespace,
      gradedBy: options.gradedBy,
      expectedSnapshotSha256: body.snapshotSha256,
      labels: labelsFromBatch(body),
    });
    return json({ ...result, results: body.grades });
  }
  return json({ error: "not found" }, 404);
}

export function createFrozenReviewHandler(
  options: FrozenGradingHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const origin = trustedOrigin(request);
      return await dispatchFrozenRequest(options, request, url, origin);
    } catch (error) {
      if (error instanceof HttpInputError)
        return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return json({ error: "invalid request" }, 400);
      return json({ error: "internal error" }, 500);
    }
  };
}

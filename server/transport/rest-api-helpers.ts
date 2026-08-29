/**
 * Shared plumbing for the REST router families (issue 864 split of
 * `src/rest-api.ts`). Request shapes, generic zod parsing, auth extraction and
 * the namespace predicate helpers used by both the write and read families.
 */
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type pg from "pg";
import type { generateEmbedding } from "../../src/embedding.ts";
import { canReadNamespace, readableNamespaces } from "../domain/read-policy.ts";
import { canWriteNamespace } from "../security/namespace-policy.ts";
import type { AuthInfo } from "../../src/types.ts";

export interface RestDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

export function getAuth(req: Request): AuthInfo | null {
  return (req as unknown as { auth?: AuthInfo }).auth ?? null;
}

export function nsError(reason: string | undefined): { error: string } {
  return { error: `Permission denied: ${reason ?? "namespace access denied"}` };
}

export const uuidSchema = z.string().uuid();
export const namespaceSchema = z.string().trim().min(1).max(500);
export const stringArraySchema = z.array(z.string()).default([]);
export const jsonRecordSchema = z.record(z.string(), z.unknown());

export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

export function parseQuery<T>(
  schema: z.ZodType<T>,
  query: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

export function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function isReadableNamespaceDenied(auth: AuthInfo, namespace?: string): boolean {
  return namespace !== undefined && !canReadNamespace(auth, namespace);
}

export function readNamespacePredicate(auth: AuthInfo, paramIndex: number): string {
  return readableNamespaces(auth) ? ` AND namespace = ANY($${paramIndex}::text[])` : "";
}

/** Columns every embeddable row writes: vector, timestamp, model name. */
export interface EmbeddingColumns {
  vector: string | null;
  embeddedAt: string | null;
  model: string | null;
}

/**
 * The `embedding ? … : null` triple every REST writer repeats, in one place so
 * a handler stays under the complexity rule. `toSqlVector` is `pgvector/pg`'s
 * `toSql`, passed in so this module stays free of the driver import.
 */
export function embeddingColumns(
  embedding: number[] | null,
  toSqlVector: (v: number[]) => string,
  modelName: string,
): EmbeddingColumns {
  if (!embedding) {
    return { vector: null, embeddedAt: null, model: null };
  }
  return {
    vector: toSqlVector(embedding),
    embeddedAt: new Date().toISOString(),
    model: modelName,
  };
}

/** `value ?? null`, as a call so a long parameter array stays flat. */
export function orNull<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * The auth + write-namespace preamble every REST writer runs. Returns the
 * resolved namespace, or `null` after it has already written the 403 response
 * (identical status codes and bodies to the pre-split router).
 */
export function resolveWriteNamespace(
  auth: AuthInfo | null,
  requested: string | undefined,
  res: Response,
): string | null {
  if (!auth) {
    res.status(403).json({ error: "Permission denied" });
    return null;
  }
  const ns = requested ?? auth.clientId;
  const check = canWriteNamespace(auth, ns);
  if (!check.allowed) {
    res.status(403).json(nsError(check.reason));
    return null;
  }
  return ns;
}

/**
 * The shared surface types the selection and repair halves of the
 * stale-embedding primitive both name: the queryable database handle and the
 * injectable embed function. Kept in one module so neither half has to import
 * the other for a type alone.
 */
import type pg from "pg";
import type { EmbeddingOptions, EmbeddingResult } from "../../src/embedding.ts";

/** Minimal queryable surface -- a pg.Pool or pg.PoolClient both satisfy this. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Signature of the metadata-returning embed function (injectable for tests). */
export type EmbedWithMetaFn = (
  text: string,
  embeddingUrl?: string,
  options?: EmbeddingOptions,
) => Promise<EmbeddingResult>;

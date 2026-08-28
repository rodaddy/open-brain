/**
 * Shared fixtures for the two live-Postgres source-sync suites
 * (src/source-sync.pg.test.ts and src/source-sync-idempotence.pg.test.ts).
 *
 * This module holds no test and creates no pool: each suite owns its own
 * module-scope pool and passes it in, so neither suite's afterAll ends a
 * connection the other is still using.
 */
import type { Pool } from "pg";
import { registerSource } from "./source-registry.ts";
import type { SourceObservation } from "./source-sync.ts";
import type { AuthInfo } from "./types.ts";
import { expectDefined } from "../scripts/test-support/expect-defined.ts";

export { expectDefined };
export const H = (n: number): string => n.toString(16).padStart(64, "0");

export function obs(files: Array<[string, string]>): SourceObservation {
  return {
    files: files.map(([path, content_hash]) => ({ path, content_hash })),
  };
}

// A token-sourced admin identity: can register+approve and write any namespace.
export function admin(): AuthInfo {
  return { role: "admin", clientId: "lane338-admin", namespaceSource: "token" };
}

/**
 * Delete the source rows the given namespaces own. Sync-run and manifest rows
 * FK-cascade from ob_sources, so this clears everything the suite created.
 */
export async function cleanupNamespaces(
  pool: Pool,
  namespaces: string[],
): Promise<void> {
  await pool.query("DELETE FROM ob_sources WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
}

/** Register + approve a git source in `namespace`, returning its id. */
export async function approvedSource(
  pool: Pool,
  namespace: string,
  externalId: string,
): Promise<string> {
  const reg = await registerSource(pool, admin(), {
    source_kind: "git",
    external_id: externalId,
    target_namespace: namespace,
    approved: true,
  });
  if (!reg.ok || !reg.data) throw new Error("register failed");
  return reg.data.id;
}

/** The live manifest (path -> {file_id, content_hash}) for a source. */
export async function liveManifest(
  pool: Pool,
  namespace: string,
  sourceId: string,
): Promise<Map<string, { file_id: string; content_hash: string }>> {
  const { rows } = await pool.query(
    `SELECT file_id, path, content_hash FROM ob_source_files
      WHERE source_id = $1 AND namespace = $2 AND state = 'live'`,
    [sourceId, namespace],
  );
  const out = new Map<string, { file_id: string; content_hash: string }>();
  for (const r of rows) {
    out.set(r.path as string, {
      file_id: r.file_id as string,
      content_hash: r.content_hash as string,
    });
  }
  return out;
}

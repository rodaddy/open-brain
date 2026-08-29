/**
 * The drop collector's authority gate and durable-root resolution.
 *
 * Split out of `drop-folder-collector.ts` (issue 864, L5). Eligibility and write
 * authority are proven here BEFORE any file is read, and the folder root is
 * taken only from the durable registry record, never from the caller.
 */
import { resolve } from "node:path";
import type pg from "pg";
import type { AuthInfo } from "../../src/types.ts";
import { canWriteNamespace } from "../security/namespace-policy.ts";
import { physicalNamespace } from "../../src/shared-namespace.ts";
import {
  resolveIngestionEligibility,
  type SourceRecord,
} from "../domain/source-registry.ts";
import { DROP_SOURCE_KIND, type DropCollectorPool } from "./drop-folder-contract.ts";

/**
 * Resolve the single eligible drop source for this collection AND prove write
 * authority. Reuses the registry ingestion gate (approved + active `drop` kind
 * in a readable namespace), then enforces canWriteNamespace against the EXACT
 * target namespace. Eligibility alone proves only read access; a
 * read-authorized but write-unauthorized caller is denied here BEFORE any file
 * is read or any row is written. No folder is ever touched on a rejection.
 */
export async function resolveEligibleDropSource(
  pool: DropCollectorPool,
  auth: AuthInfo,
  external_id: string,
  target_namespace?: string,
): Promise<
  | { eligible: true; record: SourceRecord; namespace: string }
  | {
      eligible: false;
      code: "not_found" | "approval_denied" | "namespace_denied";
    }
> {
  const gate = await resolveIngestionEligibility(pool as pg.Pool, auth, {
    source_kind: DROP_SOURCE_KIND,
    external_id,
    target_namespace,
  });
  if (!gate.ok || !gate.data) {
    // Map the registry's typed codes to the collector's content-free subset. Any
    // other/absent code collapses to not_found so an unexpected shape never
    // leaks as a distinct oracle.
    const code =
      gate.code === "approval_denied"
        ? "approval_denied"
        : gate.code === "namespace_denied"
          ? "namespace_denied"
          : "not_found";
    return { eligible: false, code };
  }

  const record = gate.data;
  // The physical namespace every durable write and the source stamp will target.
  const namespace = physicalNamespace(record.namespace);
  // Enforce WRITE authority for the exact target namespace before any read or
  // mutation. This is the fix for the P1 finding: a readonly/agent caller who
  // may read an approved source must not be able to write durable rows into a
  // namespace they cannot write (shared-kb without a promoter identity, a frozen
  // namespace like collab, etc.).
  const writeCheck = canWriteNamespace(auth, namespace);
  if (!writeCheck.allowed) {
    return { eligible: false, code: "namespace_denied" };
  }
  return { eligible: true, record, namespace };
}

// Extract the durable folder root from the source record. The root lives ONLY
// in the durable registry config (config.root); a caller can never supply it.
// A missing/blank/non-absolute root is rejected content-free so an unconfigured
// source can never read an arbitrary directory.
export function configuredRoot(record: SourceRecord): string | null {
  const raw = record.config?.root;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Require an absolute path. A relative root would resolve against the server
  // process cwd, which is not a durable, reviewable location.
  const resolved = resolve(trimmed);
  if (resolved !== trimmed && !trimmed.startsWith("/")) return null;
  return resolved;
}

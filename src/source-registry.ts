import { z } from "zod";
import { createHash } from "node:crypto";
import type pg from "pg";
import type { AuthInfo } from "./types.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import { canReadNamespace, readableNamespaces } from "./read-policy.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import { logger } from "./logger.ts";

// The only table this module touches. Interpolation is never used; every query
// names the table as a literal. Kept as an explicit allowlist constant so a
// future refactor cannot silently point registry mutations at another table.
export const SOURCE_REGISTRY_TABLE = "ob_sources" as const;

export const SOURCE_KINDS = [
  "git",
  "directory",
  "drop",
  "conversation",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const APPROVAL_STATES = ["pending", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const LIFECYCLE_STATES = ["active", "paused", "retired"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const SYNC_STATES = [
  "never_synced",
  "syncing",
  "synced",
  "error",
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

// Roles allowed to move a source into (or out of) the approved state. A
// caller-supplied approval flag is NOT authorization: approval is only honored
// when the token-sourced role is one of these AND the namespace write check
// passes. Header-delegated (namespaceSource === "header") sessions can register
// and read their own namespace but cannot grant approval.
const APPROVING_ROLES = new Set<AuthInfo["role"]>(["admin", "ob-admin"]);

// Content-safe scope: opaque key/value pairs only. Never source bodies.
const scopeSchema = z.record(z.string().min(1).max(200), z.string().max(500));

const configSchema = z.record(z.string().min(1).max(200), z.unknown());

const externalIdSchema = z.string().trim().min(1).max(1000);

// Optional explicit target namespace. When present, the write is authorized
// against THIS namespace via canWriteNamespace -- so a global admin/ob-admin
// token can register/approve into a specifically requested namespace without
// fabricating an identity whose clientId equals that namespace. When absent,
// the caller's own namespace is used. Header-scoped identities cannot broaden:
// canWriteNamespace rejects any target other than their bound header namespace.
const targetNamespaceSchema = z.string().trim().min(1).max(500);

// A stored content_hash must be the digest hashSourceContent() emits: a
// lowercase 64-char sha256 hex string. Constraining the shape (rather than
// accepting any opaque 1..200-char string) is what stops a caller from
// asserting an arbitrary value as extracted content truth. The registry does
// not re-derive it server-side (that is source-sync work, out of scope); it
// enforces that whatever is stored is at least well-formed digest-shaped.
const sourceContentHashSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{64}$/,
    "content_hash must be a lowercase sha256 hex digest",
  );

export const registerSourceInputSchema = z
  .object({
    source_kind: z.enum(SOURCE_KINDS),
    external_id: externalIdSchema,
    target_namespace: targetNamespaceSchema.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    scope: scopeSchema.optional(),
    language: z.string().trim().min(1).max(100).optional(),
    config: configSchema.optional(),
    // Convenience only. Even when true, approval is applied server-side ONLY
    // for an authorized role; otherwise the source stays pending.
    approved: z.boolean().optional(),
  })
  .strict();

export type RegisterSourceInput = z.infer<typeof registerSourceInputSchema>;

export const updateSourceInputSchema = z
  .object({
    id: z.string().uuid(),
    // Optional explicit target namespace (same semantics as register): the row
    // is located and authorized within THIS namespace. Defaults to the caller's
    // own namespace. A global admin can update/approve a foreign namespace's
    // source; header identities stay bound to their own.
    target_namespace: targetNamespaceSchema.optional(),
    // Stale/deleted-revision protection: the caller must pass the revision it
    // last observed. A mismatch (concurrent update) or missing row (deleted /
    // wrong namespace) fails without mutating.
    expected_revision: z.number().int().min(1),
    title: z.string().trim().min(1).max(500).nullable().optional(),
    scope: scopeSchema.optional(),
    language: z.string().trim().min(1).max(100).nullable().optional(),
    config: configSchema.optional(),
    lifecycle_state: z.enum(LIFECYCLE_STATES).optional(),
    sync_state: z.enum(SYNC_STATES).optional(),
    // Digest + timestamp of last-observed content. Content-free, and bound to
    // the exact shape hashSourceContent() produces (a lowercase 64-char sha256
    // hex digest) so a caller cannot assert an arbitrary opaque string as an
    // extracted content hash. null clears it.
    content_hash: sourceContentHashSchema.nullable().optional(),
    last_synced_at: z.string().datetime().nullable().optional(),
    // Approval transition. Requested here, authorized server-side.
    approval_state: z.enum(APPROVAL_STATES).optional(),
  })
  .strict();

export type UpdateSourceInput = z.infer<typeof updateSourceInputSchema>;

export interface SourceRecord {
  id: string;
  namespace: string;
  scope: Record<string, string>;
  source_kind: SourceKind;
  external_id: string;
  title: string | null;
  approval_state: ApprovalState;
  approved_by: string | null;
  approved_at: string | null;
  lifecycle_state: LifecycleState;
  sync_state: SyncState;
  language: string | null;
  config: Record<string, unknown>;
  content_hash: string | null;
  last_synced_at: string | null;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id, namespace, scope, source_kind, external_id, title,
  approval_state, approved_by, approved_at,
  lifecycle_state, sync_state, language, config,
  content_hash, last_synced_at, revision,
  created_by, created_at, updated_at
`;

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function mapRow(row: Record<string, unknown>): SourceRecord {
  return {
    id: row.id as string,
    namespace: row.namespace as string,
    scope: (row.scope as Record<string, string>) ?? {},
    source_kind: row.source_kind as SourceKind,
    external_id: row.external_id as string,
    title: (row.title as string | null) ?? null,
    approval_state: row.approval_state as ApprovalState,
    approved_by: (row.approved_by as string | null) ?? null,
    approved_at: toIso(row.approved_at),
    lifecycle_state: row.lifecycle_state as LifecycleState,
    sync_state: row.sync_state as SyncState,
    language: (row.language as string | null) ?? null,
    config: (row.config as Record<string, unknown>) ?? {},
    content_hash: (row.content_hash as string | null) ?? null,
    last_synced_at: toIso(row.last_synced_at),
    revision: row.revision as number,
    created_by: row.created_by as string,
    created_at: toIso(row.created_at) ?? "",
    updated_at: toIso(row.updated_at) ?? "",
  };
}

export interface SourceRegistryResult<T> {
  ok: boolean;
  code?:
    | "namespace_denied"
    | "approval_denied"
    | "not_found"
    | "stale_revision"
    | "conflict"
    // Retirement is terminal: an update that would mutate a retired source
    // (e.g. reactivate it to active/paused) is refused with this code. It is
    // only ever returned for a row that provably exists in the caller's OWN
    // authorized namespace, so it never becomes a cross-namespace existence
    // oracle -- a foreign/missing id still resolves to not_found.
    | "retired";
  reason?: string;
  data?: T;
}

// The effective (physical) namespace for a write. Defaults to the caller's own
// namespace; an explicit requested target namespace is honored subject to
// canWriteNamespace, which is the single server-side authority. A bare
// token-sourced global admin/ob-admin can therefore target a specifically
// requested namespace, while a header-scoped identity is rejected by
// canWriteNamespace for any target other than its bound header namespace.
// This never requires fabricating an AuthInfo whose clientId equals the target.
function effectiveWriteNamespace(auth: AuthInfo, requested?: string): string {
  return physicalNamespace(requested ?? auth.clientId);
}

// Whether an approval transition is authorized for this caller. A pending or
// rejected target is always allowed (no elevated grant); moving a source TO
// approved requires an approving role and a token (not header) namespace source.
function canApprove(auth: AuthInfo): boolean {
  if (auth.namespaceSource === "header") return false;
  return APPROVING_ROLES.has(auth.role);
}

export async function registerSource(
  pool: pg.Pool,
  auth: AuthInfo,
  input: RegisterSourceInput,
): Promise<SourceRegistryResult<SourceRecord>> {
  const namespace = effectiveWriteNamespace(auth, input.target_namespace);
  // canWriteNamespace is authorized against the resolved target namespace, not
  // the caller's clientId, so a requested foreign target is checked here.
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    return { ok: false, code: "namespace_denied", reason: nsCheck.reason };
  }

  // Caller asked for approval, but a caller-supplied flag is not authorization.
  const wantsApproval = input.approved === true;
  const approved = wantsApproval && canApprove(auth);
  if (wantsApproval && !approved) {
    // Do not silently downgrade an explicit approval request from an
    // unauthorized caller; surface it so the source is not assumed live.
    return {
      ok: false,
      code: "approval_denied",
      reason: "approval requires an authorized admin/ob-admin token identity",
    };
  }

  const approvalState: ApprovalState = approved ? "approved" : "pending";

  try {
    const { rows } = await pool.query(
      `INSERT INTO ${SOURCE_REGISTRY_TABLE}
         (namespace, scope, source_kind, external_id, title,
          approval_state, approved_by, approved_at,
          language, config, created_by)
       VALUES ($1, $2::jsonb, $3, $4, $5,
               $6, $7, ${approved ? "NOW()" : "NULL"},
               $8, $9::jsonb, $10)
       RETURNING ${SELECT_COLUMNS}`,
      [
        namespace,
        JSON.stringify(input.scope ?? {}),
        input.source_kind,
        input.external_id,
        input.title ?? null,
        approvalState,
        approved ? auth.clientId : null,
        input.language ?? null,
        JSON.stringify(input.config ?? {}),
        // created_by is the real acting identity, never the (possibly foreign)
        // target namespace. A global admin registering into another namespace
        // is attributed to its own clientId, not to that namespace.
        auth.clientId,
      ],
    );
    logger.info("source_registry_register", {
      namespace,
      source_kind: input.source_kind,
      approval_state: approvalState,
    });
    return { ok: true, data: mapRow(rows[0]) };
  } catch (err) {
    // 23505 = unique_violation (duplicate immutable identity in this namespace).
    // Re-registration of the SAME identity is idempotent when the caller's
    // requested descriptive fields match the stored row; only a genuine
    // divergence (different title/scope/language/config, or an approval the
    // caller is not authorized to keep re-asserting) is a conflict. This never
    // mutates the existing row: the durable state stays as first written.
    if (isUniqueViolation(err)) {
      const { rows: existingRows } = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM ${SOURCE_REGISTRY_TABLE}
         WHERE namespace = $1 AND source_kind = $2 AND external_id = $3`,
        [namespace, input.source_kind, input.external_id],
      );
      if (existingRows.length === 0) {
        // The conflicting row vanished between INSERT and SELECT; report a
        // content-free conflict rather than fabricate a record.
        return {
          ok: false,
          code: "conflict",
          reason: "source already registered for this namespace and kind",
        };
      }
      const existing = mapRow(existingRows[0]);
      if (isSemanticallyIdenticalRegistration(existing, input, approvalState)) {
        logger.info("source_registry_register_idempotent", {
          namespace,
          source_kind: input.source_kind,
        });
        return { ok: true, data: existing };
      }
      return {
        ok: false,
        code: "conflict",
        reason:
          "source already registered for this namespace and kind with different attributes",
      };
    }
    throw err;
  }
}

// Two registrations are semantically identical when the descriptive fields the
// caller supplied match the stored row. Omitted optional fields are not treated
// as an intent to change (register does not mutate), so they never break
// idempotency. approval_state is compared against the state this call would
// have produced: a pending re-register of an already-approved source is still
// idempotent (register never downgrades), but an authorized approved
// re-register of a pending source is a real divergence -> conflict, so the
// caller uses updateSource for the approval transition explicitly.
function isSemanticallyIdenticalRegistration(
  existing: SourceRecord,
  input: RegisterSourceInput,
  requestedApprovalState: ApprovalState,
): boolean {
  if (input.title !== undefined && (input.title ?? null) !== existing.title) {
    return false;
  }
  if (
    input.language !== undefined &&
    (input.language ?? null) !== existing.language
  ) {
    return false;
  }
  if (input.scope !== undefined && !stableEqual(input.scope, existing.scope)) {
    return false;
  }
  if (
    input.config !== undefined &&
    !stableEqual(input.config, existing.config)
  ) {
    return false;
  }
  // A re-register that would grant approval on an unapproved row is a real
  // transition, not a no-op. A pending re-register never downgrades approval.
  if (
    requestedApprovalState === "approved" &&
    existing.approval_state !== "approved"
  ) {
    return false;
  }
  return true;
}

// Order-insensitive structural equality via a stable canonical JSON encoding.
function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

export interface ListSourcesFilter {
  source_kind?: SourceKind;
  approval_state?: ApprovalState;
  lifecycle_state?: LifecycleState;
  limit?: number;
}

export async function listSources(
  pool: pg.Pool,
  auth: AuthInfo,
  filter: ListSourcesFilter = {},
): Promise<SourceRecord[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];

  // Read isolation: constrain to the caller's readable namespaces. undefined
  // means an unconstrained (admin/promoter) read across namespaces.
  const namespaces = readableNamespaces(auth);
  if (namespaces !== undefined) {
    params.push(namespaces);
    clauses.push(`namespace = ANY($${params.length}::text[])`);
  }
  if (filter.source_kind) {
    params.push(filter.source_kind);
    clauses.push(`source_kind = $${params.length}`);
  }
  if (filter.approval_state) {
    params.push(filter.approval_state);
    clauses.push(`approval_state = $${params.length}`);
  }
  if (filter.lifecycle_state) {
    params.push(filter.lifecycle_state);
    clauses.push(`lifecycle_state = $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM ${SOURCE_REGISTRY_TABLE}
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapRow);
}

export async function updateSource(
  pool: pg.Pool,
  auth: AuthInfo,
  input: UpdateSourceInput,
): Promise<SourceRegistryResult<SourceRecord>> {
  const namespace = effectiveWriteNamespace(auth, input.target_namespace);
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    return { ok: false, code: "namespace_denied", reason: nsCheck.reason };
  }

  // An approval transition to 'approved' requires authorization; a caller
  // cannot self-approve by setting approval_state in the payload.
  const grantingApproval = input.approval_state === "approved";
  if (grantingApproval && !canApprove(auth)) {
    return {
      ok: false,
      code: "approval_denied",
      reason: "approval requires an authorized admin/ob-admin token identity",
    };
  }

  const sets: string[] = [];
  // id + namespace + expected_revision are the WHERE params; kept first so
  // set-clause placeholders start after them.
  const params: unknown[] = [input.id, namespace, input.expected_revision];

  const addSet = (column: string, value: unknown, cast = ""): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (input.title !== undefined) addSet("title", input.title);
  if (input.scope !== undefined) {
    addSet("scope", JSON.stringify(input.scope), "::jsonb");
  }
  if (input.language !== undefined) addSet("language", input.language);
  if (input.config !== undefined) {
    addSet("config", JSON.stringify(input.config), "::jsonb");
  }
  if (input.lifecycle_state !== undefined) {
    addSet("lifecycle_state", input.lifecycle_state);
  }
  if (input.sync_state !== undefined) addSet("sync_state", input.sync_state);
  if (input.content_hash !== undefined) {
    addSet("content_hash", input.content_hash);
  }
  if (input.last_synced_at !== undefined) {
    addSet("last_synced_at", input.last_synced_at, "::timestamptz");
  }
  if (input.approval_state !== undefined) {
    addSet("approval_state", input.approval_state);
    if (grantingApproval) {
      addSet("approved_by", auth.clientId);
      sets.push("approved_at = NOW()");
    } else {
      // Moving away from approved clears the grant provenance.
      sets.push("approved_by = NULL");
      sets.push("approved_at = NULL");
    }
  }

  // Always advance the revision on a successful update.
  sets.push("revision = revision + 1");

  // Retirement is terminal: never let an update touch a retired row, so it can
  // never be moved back to active/paused or otherwise mutated into ingestion
  // eligibility. The lifecycle_state <> 'retired' guard makes a retired row miss
  // the UPDATE; the 0-row branch below then reports it as `retired` (within the
  // caller's own namespace only) rather than silently reactivating it.
  const { rows } = await pool.query(
    `UPDATE ${SOURCE_REGISTRY_TABLE}
       SET ${sets.join(", ")}
     WHERE id = $1 AND namespace = $2 AND revision = $3
       AND lifecycle_state <> 'retired'
     RETURNING ${SELECT_COLUMNS}`,
    params,
  );

  if (rows.length === 0) {
    // Distinguish retired / stale revision / missing (deleted or wrong
    // namespace). The existence probe reads lifecycle_state and revision WITHIN
    // the caller's own authorized namespace only, so a foreign or absent id is
    // indistinguishable from a genuinely missing one (no cross-namespace
    // existence oracle).
    const { rows: existing } = await pool.query(
      `SELECT revision, lifecycle_state FROM ${SOURCE_REGISTRY_TABLE}
       WHERE id = $1 AND namespace = $2`,
      [input.id, namespace],
    );
    if (existing.length === 0) {
      return { ok: false, code: "not_found", reason: "source not found" };
    }
    if (existing[0].lifecycle_state === "retired") {
      // Terminal state: the row exists and is retired. Report it as retired
      // regardless of the supplied expected_revision, so a caller cannot probe
      // for staleness on a retired row.
      return {
        ok: false,
        code: "retired",
        reason: "source is retired and cannot be modified",
      };
    }
    return {
      ok: false,
      code: "stale_revision",
      reason: "source was modified concurrently; re-read and retry",
    };
  }

  logger.info("source_registry_update", {
    namespace,
    id: input.id,
  });
  return { ok: true, data: mapRow(rows[0]) };
}

// Remove is a soft delete: it retires the source so it can never become
// ingestion-eligible again while preserving provenance. Namespace-qualified.
export async function removeSource(
  pool: pg.Pool,
  auth: AuthInfo,
  id: string,
  targetNamespace?: string,
): Promise<SourceRegistryResult<{ id: string }>> {
  const namespace = effectiveWriteNamespace(auth, targetNamespace);
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    return { ok: false, code: "namespace_denied", reason: nsCheck.reason };
  }

  const { rows } = await pool.query(
    `UPDATE ${SOURCE_REGISTRY_TABLE}
       SET lifecycle_state = 'retired', revision = revision + 1
     WHERE id = $1 AND namespace = $2 AND lifecycle_state <> 'retired'
     RETURNING id`,
    [id, namespace],
  );
  if (rows.length > 0) {
    logger.info("source_registry_remove", { namespace, id });
    return { ok: true, data: { id: rows[0].id as string } };
  }
  // The retiring UPDATE matched nothing: either the row is already retired (a
  // repeat remove) or it does not exist in this namespace. Remove is idempotent,
  // so a repeat remove of an already-retired row is a truthful success/no-op --
  // it must NOT bump the revision again. Probe existence WITHIN the caller's own
  // authorized namespace only, so a missing or wrong-namespace id stays
  // not_found and is indistinguishable from a genuinely absent one.
  const { rows: existing } = await pool.query(
    `SELECT id FROM ${SOURCE_REGISTRY_TABLE}
     WHERE id = $1 AND namespace = $2 AND lifecycle_state = 'retired'`,
    [id, namespace],
  );
  if (existing.length > 0) {
    // Already retired: no-op success, revision untouched.
    return { ok: true, data: { id: existing[0].id as string } };
  }
  return { ok: false, code: "not_found", reason: "source not found" };
}

// Ingestion gate: a source location is eligible ONLY if a registry entry for
// this exact namespace + kind + external identity is approved and active. A
// caller-supplied approval flag never reaches this path; eligibility is derived
// purely from the durable server-side state. Returns the record when eligible,
// or a rejection with a content-free reason.
export async function resolveIngestionEligibility(
  pool: pg.Pool,
  auth: AuthInfo,
  input: {
    source_kind: SourceKind;
    external_id: string;
    target_namespace?: string;
  },
): Promise<SourceRegistryResult<SourceRecord>> {
  const namespace = effectiveWriteNamespace(auth, input.target_namespace);
  // A requested foreign target must be readable by this caller; otherwise the
  // gate would leak another namespace's registration state as an existence
  // oracle. The default (own namespace) is always readable.
  if (
    input.target_namespace !== undefined &&
    !canReadNamespace(auth, namespace)
  ) {
    return {
      ok: false,
      code: "not_found",
      reason: "source is not registered for this namespace",
    };
  }
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM ${SOURCE_REGISTRY_TABLE}
     WHERE namespace = $1 AND source_kind = $2 AND external_id = $3`,
    [namespace, input.source_kind, input.external_id],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      code: "not_found",
      reason: "source is not registered for this namespace",
    };
  }
  const record = mapRow(rows[0]);
  if (record.approval_state !== "approved") {
    return {
      ok: false,
      code: "approval_denied",
      reason: "source is registered but not approved",
    };
  }
  if (record.lifecycle_state !== "active") {
    return {
      ok: false,
      code: "approval_denied",
      reason: "source is not in an active lifecycle state",
    };
  }
  return { ok: true, data: record };
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "23505",
  );
}

// Version tag for the content-hash algorithm. Bumped only if the canonicalization
// or digest changes, so a stored hash's provenance stays unambiguous.
export const SOURCE_CONTENT_HASH_VERSION = "sha256.v1" as const;

// A deterministic, content-free envelope describing observed source content.
// Collectors compute this from the ACTUAL bytes/text they read (via
// hashSourceContent below); the registry never accepts a caller-asserted digest
// as extracted truth. The envelope carries only structural metadata -- length,
// an opaque digest, and the algorithm version -- never the source body itself.
export interface SourceContentEnvelope {
  content_hash: string;
  hash_version: typeof SOURCE_CONTENT_HASH_VERSION;
  byte_length: number;
}

// Deterministic digest of raw source content. Accepts a string or bytes so a
// git/directory/drop/conversation collector can hash exactly what it read. The
// digest is stable for identical input across processes and machines. Callers
// pass the RESULT (a proven digest), not an unverified hash string, to
// updateSource. This helper never logs or returns the content.
export function hashSourceContent(
  content: string | Uint8Array,
): SourceContentEnvelope {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const content_hash = createHash("sha256").update(bytes).digest("hex");
  return {
    content_hash,
    hash_version: SOURCE_CONTENT_HASH_VERSION,
    byte_length: bytes.byteLength,
  };
}

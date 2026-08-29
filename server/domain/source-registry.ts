import type pg from "pg";
import type { AuthInfo } from "../../src/types.ts";
import { canWriteNamespace } from "../../src/namespace-policy.ts";
import { canReadNamespace, readableNamespaces } from "../../src/read-policy.ts";
import { logger } from "../../src/logger.ts";
import {
  SELECT_COLUMNS,
  SOURCE_REGISTRY_TABLE,
  canApprove,
  effectiveWriteNamespace,
  isUniqueViolation,
  mapRow,
} from "./source-registry-model.ts";
import type {
  ApprovalState,
  RegisterSourceInput,
  SourceRecord,
  SourceRegistryResult,
  UpdateSourceInput,
  SourceKind,
  LifecycleState,
} from "./source-registry-model.ts";

// The model surface is re-exported so a caller has one import site for the
// registry, exactly as it did when both halves lived in one file.
export * from "./source-registry-model.ts";

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
    const inserted = await insertSourceRow(pool, {
      namespace,
      auth,
      input,
      approved,
      approvalState,
    });
    logger.info("source_registry_register", {
      namespace,
      source_kind: input.source_kind,
      approval_state: approvalState,
    });
    return { ok: true, data: mapRow(inserted) };
  } catch (err) {
    // 23505 = unique_violation (duplicate immutable identity in this namespace).
    // Re-registration of the SAME identity is idempotent when the caller's
    // requested descriptive fields match the stored row; only a genuine
    // divergence (different title/scope/language/config, or an approval the
    // caller is not authorized to keep re-asserting) is a conflict. This never
    // mutates the existing row: the durable state stays as first written.
    if (isUniqueViolation(err)) {
      return await resolveDuplicateRegistration(pool, namespace, input, approvalState);
    }
    throw err;
  }
}

interface InsertSourceRowArgs {
  namespace: string;
  auth: AuthInfo;
  input: RegisterSourceInput;
  approved: boolean;
  approvalState: ApprovalState;
}

// The INSERT itself. approved_at is the only interpolated fragment and is a
// literal chosen from a boolean, never caller text; every value is a bound
// parameter. created_by is the real acting identity, never the (possibly
// foreign) target namespace, so a global admin registering into another
// namespace is attributed to its own clientId.
async function insertSourceRow(
  pool: pg.Pool,
  args: InsertSourceRowArgs,
): Promise<Record<string, unknown>> {
  const { namespace, auth, input, approved, approvalState } = args;
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
      auth.clientId,
    ],
  );
  const inserted = rows[0];
  if (!inserted) {
    // A RETURNING insert that matched no row cannot happen without an error
    // being thrown first; refuse rather than fabricate a record.
    throw new Error("source registry insert returned no row");
  }
  return inserted;
}

// Re-registration of an identity that already exists in this namespace. The
// stored row is never mutated: an identical registration resolves to the
// existing record, a divergent one to a content-free conflict.
async function resolveDuplicateRegistration(
  pool: pg.Pool,
  namespace: string,
  input: RegisterSourceInput,
  approvalState: ApprovalState,
): Promise<SourceRegistryResult<SourceRecord>> {
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
  if (!describedFieldsMatch(existing, input)) return false;
  // A re-register that would grant approval on an unapproved row is a real
  // transition, not a no-op. A pending re-register never downgrades approval.
  return !(
    requestedApprovalState === "approved" && existing.approval_state !== "approved"
  );
}

// Every descriptive field the caller actually supplied must equal the stored
// value. An omitted optional field is not an intent to change, so it is skipped
// rather than compared against null.
function describedFieldsMatch(
  existing: SourceRecord,
  input: RegisterSourceInput,
): boolean {
  const scalarChanged =
    (input.title !== undefined && (input.title ?? null) !== existing.title) ||
    (input.language !== undefined && (input.language ?? null) !== existing.language);
  if (scalarChanged) return false;
  const structuralChanged =
    (input.scope !== undefined && !stableEqual(input.scope, existing.scope)) ||
    (input.config !== undefined && !stableEqual(input.config, existing.config));
  return !structuralChanged;
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
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
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

// The updatable columns that carry a value straight through, with the jsonb
// encoding and the SQL cast each one needs. approval_state is NOT here: it
// carries the approved_by/approved_at provenance transition with it and is
// handled explicitly. Keys are column-name literals, never caller text.
const UPDATE_COLUMN_SPECS = {
  title: { encode: false, cast: "" },
  scope: { encode: true, cast: "::jsonb" },
  language: { encode: false, cast: "" },
  config: { encode: true, cast: "::jsonb" },
  lifecycle_state: { encode: false, cast: "" },
  sync_state: { encode: false, cast: "" },
  content_hash: { encode: false, cast: "" },
  last_synced_at: { encode: false, cast: "::timestamptz" },
} as const satisfies Record<string, { encode: boolean; cast: string }>;

const PLAIN_UPDATE_COLUMNS = Object.keys(
  UPDATE_COLUMN_SPECS,
) as (keyof typeof UPDATE_COLUMN_SPECS)[];

interface UpdateAssignmentArgs {
  namespace: string;
  auth: AuthInfo;
  input: UpdateSourceInput;
  grantingApproval: boolean;
}

// The SET clause for an update, built only from the fields the caller actually
// supplied. Column names are literals here; every value is a bound parameter.
// id + namespace + expected_revision are the WHERE params and are kept first so
// set-clause placeholders start after them.
function buildUpdateAssignments(args: UpdateAssignmentArgs): {
  sets: string[];
  params: unknown[];
} {
  const { auth, input, grantingApproval } = args;
  const sets: string[] = [];
  const params: unknown[] = [input.id, args.namespace, input.expected_revision];

  const addSet = (column: string, value: unknown, cast = ""): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  for (const column of PLAIN_UPDATE_COLUMNS) {
    const value = input[column];
    if (value === undefined) continue;
    const spec = UPDATE_COLUMN_SPECS[column];
    addSet(column, spec.encode ? JSON.stringify(value) : value, spec.cast);
  }

  if (input.approval_state !== undefined) {
    addSet("approval_state", input.approval_state);
    if (grantingApproval) {
      addSet("approved_by", auth.clientId);
      sets.push("approved_at = NOW()");
    } else {
      // Moving away from approved clears the grant provenance.
      sets.push("approved_by = NULL", "approved_at = NULL");
    }
  }

  // Always advance the revision on a successful update.
  sets.push("revision = revision + 1");
  return { sets, params };
}

// Why an update matched no row: retired / stale revision / missing (deleted or
// wrong namespace). The existence probe reads lifecycle_state and revision
// WITHIN the caller's own authorized namespace only, so a foreign or absent id
// is indistinguishable from a genuinely missing one (no cross-namespace
// existence oracle).
async function diagnoseUpdateMiss(
  pool: pg.Pool,
  id: string,
  namespace: string,
): Promise<SourceRegistryResult<SourceRecord>> {
  const { rows: existing } = await pool.query(
    `SELECT revision, lifecycle_state FROM ${SOURCE_REGISTRY_TABLE}
     WHERE id = $1 AND namespace = $2`,
    [id, namespace],
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

  const { sets, params } = buildUpdateAssignments({
    namespace,
    auth,
    input,
    grantingApproval,
  });

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
    return await diagnoseUpdateMiss(pool, input.id, namespace);
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
  if (input.target_namespace !== undefined && !canReadNamespace(auth, namespace)) {
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

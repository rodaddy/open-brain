import { z } from "zod";
import { createHash } from "node:crypto";
import type { AuthInfo } from "../../src/types.ts";
import { physicalNamespace } from "../../src/shared-namespace.ts";

// The only table this module touches. Interpolation is never used; every query
// names the table as a literal. Kept as an explicit allowlist constant so a
// future refactor cannot silently point registry mutations at another table.
export const SOURCE_REGISTRY_TABLE = "ob_sources" as const;

export const SOURCE_KINDS = ["git", "directory", "drop", "conversation"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const APPROVAL_STATES = ["pending", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const LIFECYCLE_STATES = ["active", "paused", "retired"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const SYNC_STATES = ["never_synced", "syncing", "synced", "error"] as const;
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
  .regex(/^[0-9a-f]{64}$/, "content_hash must be a lowercase sha256 hex digest");

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

export const SELECT_COLUMNS = `
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

export function mapRow(row: Record<string, unknown>): SourceRecord {
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
export function effectiveWriteNamespace(auth: AuthInfo, requested?: string): string {
  return physicalNamespace(requested ?? auth.clientId);
}

// Whether an approval transition is authorized for this caller. A pending or
// rejected target is always allowed (no elevated grant); moving a source TO
// approved requires an approving role and a token (not header) namespace source.
export function canApprove(auth: AuthInfo): boolean {
  if (auth.namespaceSource === "header") return false;
  return APPROVING_ROLES.has(auth.role);
}

export function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { code?: unknown }).code === "23505",
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
export function hashSourceContent(content: string | Uint8Array): SourceContentEnvelope {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const content_hash = createHash("sha256").update(bytes).digest("hex");
  return {
    content_hash,
    hash_version: SOURCE_CONTENT_HASH_VERSION,
    byte_length: bytes.byteLength,
  };
}

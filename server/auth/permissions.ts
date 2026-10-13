/**
 * Role-to-resource permission boundary.
 *
 * Design authority: `docs/decisions/admin-and-promoter-identities.md` fixes the
 * promoter denial set and the full `ob-admin` break-glass surface.
 */
import type { Role } from "../config.ts";
import type { Permission, ResourceTable } from "./types.ts";

// Frozen so a caller cannot mutate a shared permission set and widen the
// boundary for every role that references it.
const RWD = Object.freeze(new Set<Permission>(["read", "write", "delete"]));
const RW = Object.freeze(new Set<Permission>(["read", "write"]));
const RO = Object.freeze(new Set<Permission>(["read"]));
const WO = Object.freeze(new Set<Permission>(["write"]));
const NONE = Object.freeze(new Set<Permission>());

type TablePermissions = Readonly<Record<ResourceTable, ReadonlySet<Permission>>>;

const FULL_ACCESS: TablePermissions = {
  thoughts: RWD,
  decisions: RWD,
  relationships: RWD,
  projects: RWD,
  sessions: RWD,
};

export const PERMISSIONS: Readonly<Record<Role, TablePermissions>> = {
  admin: FULL_ACCESS,
  // Break-glass server-side admin identity (#168). Full RWD on every table --
  // identical to `admin`. This is the honest name for what was historically the
  // misnamed, 100%-unused `n8n` role; it is for HUMAN server-side surgery
  // (deletions, manual user promotions), not for n8n.io automations.
  "ob-admin": FULL_ACCESS,
  // Promotion service identity (#147). Reads source entries and writes/archives
  // into the shared namespace with provenance. RWD on curation tables so
  // promote + demote/archive work; RO on projects (promotion never authors
  // projects). Namespace authority (who can write shared-kb) is enforced
  // separately in namespace-policy.isPromoterIdentity.
  promoter: {
    thoughts: RWD,
    decisions: RWD,
    relationships: RWD,
    projects: RO,
    sessions: RWD,
  },
  agent: {
    thoughts: RW,
    decisions: RW,
    relationships: RW,
    projects: RO,
    sessions: RW,
  },
  discord: {
    thoughts: WO,
    decisions: NONE,
    relationships: NONE,
    projects: NONE,
    sessions: NONE,
  },
  readonly: {
    thoughts: RO,
    decisions: RO,
    relationships: RO,
    projects: RO,
    sessions: RO,
  },
};

/** @returns Whether the role may read the resource table. */
export function canRead(role: Role, table: ResourceTable): boolean {
  return PERMISSIONS[role][table].has("read");
}

/** @returns Whether the role may write the resource table. */
export function canWrite(role: Role, table: ResourceTable): boolean {
  return PERMISSIONS[role][table].has("write");
}

/** @returns Whether the role may delete from the resource table. */
export function canDelete(role: Role, table: ResourceTable): boolean {
  return PERMISSIONS[role][table].has("delete");
}
